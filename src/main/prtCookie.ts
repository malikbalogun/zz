/**
 * Primary Refresh Token (PRT) cookie minting for Microsoft Entra ID.
 *
 * Implements the device-registration + session-key + JWT-mint flow that the
 * Windows AAD broker (and tools like roadtx / AADInternals) use to produce
 * a `x-ms-RefreshTokenCredential` cookie. Pasting this cookie on
 * `login.microsoftonline.com` allows AAD to silently issue ESTSAUTH
 * cookies for the destination browser session — i.e. the user is signed
 * into OWA in any real browser without password / MFA.
 *
 * High-level flow:
 *
 *   1. Acquire a "device registration" access token from the user's
 *      existing refresh token (resource =
 *      urn:ms-drs:enterpriseregistration.windows.net).
 *   2. Generate an RSA-2048 keypair locally and a self-signed PKCS#10 CSR.
 *   3. POST to https://enterpriseregistration.windows.net/EnrollmentServer/device/?api-version=1.0
 *      with the DRS token + CSR. AAD returns a device certificate (issued
 *      by "MS-Organization-Access") + tenant_id + device_id.
 *   4. Use the device cert to authenticate a /oauth2/token call with
 *      grant_type=srv_challenge. AAD returns:
 *         - session_key_jwe  : 32-byte session key wrapped via RSA-OAEP-SHA1
 *                              with the device cert public key.
 *         - id_token         : informational
 *   5. Decrypt session_key_jwe with the device private key.
 *   6. Mint the PRT cookie:
 *        - 24-byte random context nonce
 *        - derive sign key from session_key via SP800-108 KDF
 *          (label = "AzureAD-SecureConversation")
 *        - JWT header  = { alg: "HS256", ctx: base64url(nonce) }
 *        - JWT body    = { refresh_token, is_primary: "true",
 *                          request_nonce, iat }
 *        - HMAC-SHA256 sign with the derived key
 *
 * Persistence: device cert + private key + session key are cached
 * encrypted on the account (auth.prtRegistrationEncrypted) so subsequent
 * mints are instant — no further DRS calls until the device cert
 * expires (~10 years) or the session key is rotated.
 */

import crypto from 'crypto';
import forge from 'node-forge';
import { refreshMicrosoftToken } from './microsoftOAuthRefresh';

// AAD's well-known Device Registration Service (DRS) resource. The token
// we mint here is the one DRS accepts for /EnrollmentServer/device/.
const DRS_RESOURCE = 'urn:ms-drs:enterpriseregistration.windows.net';
// The "Microsoft Authentication Broker" client. This is the FOCI client
// that mints PRTs on real Windows devices and is what roadtx uses too.
// FOCI = Family of Client IDs: any FOCI refresh token can be redeemed at
// any other FOCI client, including this one.
const BROKER_CLIENT_ID = '29d9ed98-a469-4536-ade2-f981bc1d605e';
// Secure Conversation label used when deriving the signing key from the
// session key (matches AAD's KDF on the verification side).
const KDF_LABEL = Buffer.from('AzureAD-SecureConversation', 'utf8');

// ---------------------------------------------------------------------------
// Stored shape (encrypted on the account as auth.prtRegistrationEncrypted)
// ---------------------------------------------------------------------------

export interface PrtRegistration {
  /** PEM-encoded RSA private key for the device. */
  privateKeyPem: string;
  /** PEM-encoded device certificate AAD issued. */
  deviceCertPem: string;
  /** Tenant ID returned by DRS (GUID). */
  tenantId: string;
  /** Device ID AAD assigned to the registration (GUID). */
  deviceId: string;
  /** Session key (raw 32 bytes) base64-encoded. Refreshed by srv_challenge. */
  sessionKeyB64: string;
  /** ISO timestamp of the most recent srv_challenge. */
  sessionKeyAcquiredAt: string;
  /** ISO timestamp of the original registration. */
  registeredAt: string;
}

// ---------------------------------------------------------------------------
// Step 1 — DRS access token from the user's refresh token
// ---------------------------------------------------------------------------

/** Direct v1 token-endpoint hit — refreshMicrosoftToken does smart fallback
 *  to v2 + .default scope for Office tokens, but DRS does not have a
 *  .default scope on v2: we MUST use v1 with `resource=urn:ms-drs:...`.
 *  Returns the bare access_token + (rotated) refresh_token. Throws with
 *  the AADSTS code on failure. */
async function tokenV1(
  clientId: string,
  tenant: string,
  refreshToken: string,
  resource: string,
  attempt: number = 1
): Promise<{ accessToken: string; refreshToken: string }> {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
    resource,
  });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`v1 token endpoint refused (${res.status}): ${text.substring(0, 600)}`);
    }
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`v1 token response not JSON: ${text.substring(0, 200)}`);
    }
    if (!data.access_token) {
      throw new Error(`v1 token response missing access_token (keys: ${Object.keys(data).join(', ')})`);
    }
    return {
      accessToken: String(data.access_token),
      refreshToken: String(data.refresh_token || refreshToken),
    };
  } catch (err: any) {
    clearTimeout(timeoutId);
    const msg = String(err?.message || err);
    const isNetwork =
      err?.name === 'AbortError' ||
      msg.includes('fetch') ||
      msg.includes('network') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('ENETUNREACH');
    if (isNetwork && attempt < 3) {
      const delay = 750 * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
      return tokenV1(clientId, tenant, refreshToken, resource, attempt + 1);
    }
    throw err;
  }
}

/** Decode JWT body (no signature check) — for inspecting `aud` to verify
 *  we got the right audience back. Returns null on parse failure. */
function decodeJwtBody(jwt: string): any | null {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Get a DRS-audience access token. Strategy:
 *
 *   1. Try the v1 token endpoint with the user's existing client_id and
 *      `resource=urn:ms-drs:enterpriseregistration.windows.net`. If the
 *      app supports FOCI (every Office / Outlook / Authenticator client
 *      does), AAD honours the resource and returns a DRS token directly.
 *   2. If step 1 returns the wrong audience (some non-FOCI clients
 *      ignore `resource` and return an audience-stamped token from the
 *      original scope), redeem the rotated refresh token at the
 *      Microsoft Authentication Broker client (29d9...) which is FOCI
 *      and always accepts DRS as a resource.
 *   3. Validate the resulting token's `aud` claim before handing it back
 *      so we fail loudly if AAD silently downgraded again.
 */
async function acquireDrsAccessToken(
  clientId: string,
  authorityEndpoint: string,
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const tenant = (authorityEndpoint || 'common').trim() || 'common';
  let attempt = await tokenV1(clientId, tenant, refreshToken, DRS_RESOURCE);
  let claims = decodeJwtBody(attempt.accessToken);
  let aud: string = String(claims?.aud || '');
  if (!aud.includes('enterpriseregistration.windows.net') && !aud.includes(DRS_RESOURCE)) {
    // Original client returned the wrong audience — redeem at the broker.
    attempt = await tokenV1(BROKER_CLIENT_ID, tenant, attempt.refreshToken, DRS_RESOURCE);
    claims = decodeJwtBody(attempt.accessToken);
    aud = String(claims?.aud || '');
  }
  if (!aud.includes('enterpriseregistration.windows.net') && !aud.includes(DRS_RESOURCE)) {
    throw new Error(
      `Could not acquire DRS-audience access token (got aud="${aud}"). ` +
      `This usually means the account's refresh token is not from a FOCI client; ` +
      `re-add the account via Device Code (Microsoft Office 365 client) and try again.`
    );
  }
  return attempt;
}

/** Side-effect-free wrapper kept around for the unused-import linter. */
void refreshMicrosoftToken;

// ---------------------------------------------------------------------------
// Step 2 — RSA-2048 keypair + PKCS#10 CSR (self-signed)
// ---------------------------------------------------------------------------

interface CsrBundle {
  /** PEM-encoded private key. */
  privateKeyPem: string;
  /** Base64-encoded PKCS#10 CertificateRequest (no PEM headers). */
  csrB64: string;
  /** node-forge keypair (kept for downstream use in the same call). */
  keypair: forge.pki.rsa.KeyPair;
  /** Base64-encoded BCRYPT_RSAKEY_BLOB of the public key (TransportKey). */
  transportKeyB64: string;
}

/**
 * Build a BCRYPT_RSAKEY_BLOB (the Windows binary RSA public-key format AAD
 * DRS expects in the TransportKey field).
 *
 * Layout (little-endian):
 *   ULONG Magic        // 'RSA1' (0x31415352) for public key
 *   ULONG BitLength    // e.g. 2048
 *   ULONG cbPublicExp  // length of public exponent in bytes
 *   ULONG cbModulus    // length of modulus in bytes
 *   ULONG cbPrime1     // 0 for public key
 *   ULONG cbPrime2     // 0 for public key
 *   BYTE  PublicExponent[cbPublicExp]   // big-endian
 *   BYTE  Modulus[cbModulus]            // big-endian
 */
function buildBcryptRsaPubKeyBlob(pubKey: forge.pki.rsa.PublicKey): Buffer {
  // forge stores n / e as BigInteger; convert to big-endian byte arrays.
  const modulusHex = pubKey.n.toString(16);
  const modulusEvenHex = modulusHex.length % 2 === 0 ? modulusHex : '0' + modulusHex;
  const modulus = Buffer.from(modulusEvenHex, 'hex');
  const expHex = pubKey.e.toString(16);
  const expEvenHex = expHex.length % 2 === 0 ? expHex : '0' + expHex;
  const exponent = Buffer.from(expEvenHex, 'hex');

  const header = Buffer.alloc(24);
  header.writeUInt32LE(0x31415352, 0); // 'RSA1'
  header.writeUInt32LE(modulus.length * 8, 4); // BitLength
  header.writeUInt32LE(exponent.length, 8); // cbPublicExp
  header.writeUInt32LE(modulus.length, 12); // cbModulus
  header.writeUInt32LE(0, 16); // cbPrime1
  header.writeUInt32LE(0, 20); // cbPrime2
  return Buffer.concat([header, exponent, modulus]);
}

function generateRsaCsr(commonName: string): CsrBundle {
  const keypair = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keypair.publicKey;
  csr.setSubject([{ name: 'commonName', value: commonName }]);
  csr.sign(keypair.privateKey, forge.md.sha256.create());
  // AAD wants the CSR DER bytes base64'd, no PEM banner.
  const der = forge.asn1.toDer(forge.pki.certificationRequestToAsn1(csr)).getBytes();
  const csrB64 = forge.util.encode64(der);
  const privateKeyPem = forge.pki.privateKeyToPem(keypair.privateKey);
  const transportKeyBlob = buildBcryptRsaPubKeyBlob(keypair.publicKey);
  const transportKeyB64 = transportKeyBlob.toString('base64');
  return { privateKeyPem, csrB64, keypair, transportKeyB64 };
}

// ---------------------------------------------------------------------------
// Step 3 — Register the device with DRS
// ---------------------------------------------------------------------------

interface DrsRegisterResult {
  /** PEM-encoded device certificate AAD issued. */
  deviceCertPem: string;
  /** Tenant ID (GUID), extracted from the cert subject. */
  tenantId: string;
  /** Device ID AAD assigned to the registration (GUID), extracted from cert subject. */
  deviceId: string;
}

/** Headers AAD's DRS endpoint expects from a Windows-style enrollment client.
 *  The User-Agent is sniffed by AAD and unrecognised values get rejected
 *  with InvalidParameter / 400 errors that don't mention the actual cause. */
function drsHeaders(bearer: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${bearer}`,
    'User-Agent': 'Dsreg/10.0 (Windows 10.0.19044.1466)',
    'ocp-adrs-client-name': 'Dsreg',
    'ocp-adrs-client-version': '10.0.19044.1466',
    Accept: 'application/json',
  };
}

/** Pull tenant/device GUIDs out of the issued cert's Subject CN/OU.
 *  Microsoft DRS encodes:   CN=<deviceId>, OU=<tenantId>, DC=...           */
function extractIdsFromCertSubject(cert: forge.pki.Certificate): { deviceId: string; tenantId: string } {
  let deviceId = '';
  let tenantId = '';
  for (const attr of cert.subject.attributes) {
    const name = (attr.shortName || attr.name || '').toString();
    const value = String(attr.value || '');
    if (name === 'CN' || name === 'commonName') deviceId = value;
    else if (name === 'OU' || name === 'organizationalUnitName') tenantId = value;
  }
  return { deviceId, tenantId };
}

/** Pulled out so the caller can pass `targetDomain` as the canonical
 *  tenant fallback when AAD's cert subject only carries the device ID. */
async function registerDeviceWithDrs(
  drsAccessToken: string,
  csrB64: string,
  transportKeyB64: string,
  deviceDisplayName: string,
  targetDomain: string
): Promise<DrsRegisterResult> {
  // API 1.0 is what roadtx and the actual Windows broker use. 2.0 exists
  // but rejects the same body shape with the same generic error, so 1.0
  // is the safer pick.
  const url = 'https://enterpriseregistration.windows.net/EnrollmentServer/device/?api-version=1.0';
  // Body shape lifted directly from roadtx (which is the canonical
  // open-source PRT implementation against AAD). The two fields DRS
  // actually treats as required — and which my earlier body was missing —
  // are TargetDomain and AttestationData. Without TargetDomain DRS can't
  // route the request, so it returns the generic
  // error_required_parameter_missing without naming the missing field.
  const body = {
    CertificateRequest: { Type: 'pkcs10', Data: csrB64 },
    TransportKey: transportKeyB64,
    TargetDomain: targetDomain,
    DeviceType: 'Windows',
    OSVersion: '10.0.19044.1466',
    DeviceDisplayName: deviceDisplayName,
    // JoinType 0 = "Azure AD Join". roadtx + the Windows broker both use
    // 0 here. JoinType 4 (Workplace Join) is for a different DRS
    // endpoint shape and gets rejected on /EnrollmentServer/device/.
    JoinType: 0,
    AttestationData: '',
  };
  console.log('[PRT] DRS register POST', url);
  console.log('[PRT] DRS register body keys', Object.keys(body));
  const res = await fetch(url, {
    method: 'POST',
    headers: drsHeaders(drsAccessToken),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `DRS device registration failed (${res.status}): ${text.substring(0, 800)}`
    );
  }
  const data = (await res.json()) as any;
  // AAD v2 returns the device certificate base64-encoded under
  // "Certificate.RawBody". Older v1 callers see "Certificate.Data".
  const certB64: string | undefined = data?.Certificate?.RawBody || data?.Certificate?.Data;
  if (!certB64) {
    throw new Error(
      `DRS response missing Certificate.RawBody (keys: ${Object.keys(data || {}).join(', ')})`
    );
  }
  // Try DER → cert; fall back to PKCS#7 SignedData container if needed.
  let cert: forge.pki.Certificate;
  try {
    const certBytes = forge.util.decode64(certB64);
    const asn1 = forge.asn1.fromDer(certBytes);
    cert = forge.pki.certificateFromAsn1(asn1);
  } catch {
    const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.decode64(certB64)));
    const certs = (p7 as any).certificates as forge.pki.Certificate[];
    if (!certs || !certs.length) throw new Error('DRS PKCS#7 contained no certificates');
    cert = certs[0];
  }
  const deviceCertPem = forge.pki.certificateToPem(cert);

  // Modern AAD only puts the device GUID in the cert's CN; the tenant
  // GUID isn't encoded in the Subject anymore (older AAD did, in OU).
  // Fall back to the JSON envelope, then to the targetDomain we asked
  // for (which is the DRS-token's tid claim — guaranteed to be the
  // home tenant). Device ID has the same fallback chain in case a
  // future AAD version moves it too.
  const fromSubject = extractIdsFromCertSubject(cert);
  const tenantId =
    fromSubject.tenantId ||
    data?.User?.DirectoryTenantId ||
    data?.TenantId ||
    targetDomain ||
    '';
  const deviceId =
    fromSubject.deviceId ||
    data?.Device?.DeviceId ||
    data?.DeviceId ||
    '';
  if (!tenantId || !deviceId) {
    throw new Error(
      `DRS response did not yield tenant/device IDs (cert subject CN=${fromSubject.deviceId || '?'}, OU=${fromSubject.tenantId || '?'}, targetDomain=${targetDomain || '?'})`
    );
  }
  return { deviceCertPem, tenantId, deviceId };
}

// ---------------------------------------------------------------------------
// Step 4 + 5 — srv_challenge → session key
// ---------------------------------------------------------------------------

async function fetchAadNonce(authority: string): Promise<string> {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(authority)}/oauth2/token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'srv_challenge' }).toString(),
  });
  // AAD returns 200 with { Nonce: "..." } even for srv_challenge probes.
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Could not fetch AAD nonce (${res.status}): ${text.substring(0, 400)}`);
  }
  const data = (await res.json()) as any;
  if (!data?.Nonce) throw new Error('AAD nonce response missing Nonce field');
  return String(data.Nonce);
}

function buildClientAssertionJwt(
  refreshToken: string,
  nonce: string,
  privateKeyPem: string,
  deviceCertPem: string,
  clientIdForAssertion: string
): string {
  // x5c header lets AAD verify our signature against the device cert it
  // just issued (so the chain is: AAD trusts itself → trusts the device
  // cert → trusts the assertion JWT).
  const certDer = forge.asn1
    .toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(deviceCertPem)))
    .getBytes();
  const x5c = forge.util.encode64(certDer);
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    x5c: [x5c],
  };
  // CRITICAL: client_id MUST be the Microsoft Authentication Broker
  // (29d9ed98-...). Only this FOCI client is authorized to mint PRTs
  // via srv_challenge — Office (d3590...) and other apps get
  // AADSTS700019 ("Application ID ... cannot be used or is not
  // authorized"). The refresh_token in the body should therefore also
  // be a broker-issued one (we redeem via FOCI before getting here).
  const body = {
    client_id: clientIdForAssertion,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    request_nonce: nonce,
    scope: 'openid aza ugs',
    win_ver: '10.0.19041.1.amd64fre.vb_release.191206-1406',
  };
  const headerB64 = base64url(Buffer.from(JSON.stringify(header), 'utf8'));
  const bodyB64 = base64url(Buffer.from(JSON.stringify(body), 'utf8'));
  const signingInput = `${headerB64}.${bodyB64}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'ascii'), {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  return `${signingInput}.${base64url(signature)}`;
}

interface SrvChallengeResult {
  /** Raw 32-byte session key (decrypted from the JWE AAD returned). */
  sessionKey: Buffer;
}

async function srvChallenge(
  authority: string,
  refreshToken: string,
  privateKeyPem: string,
  deviceCertPem: string,
  clientIdForAssertion: string = BROKER_CLIENT_ID
): Promise<SrvChallengeResult> {
  const nonce = await fetchAadNonce(authority);
  const assertion = buildClientAssertionJwt(
    refreshToken,
    nonce,
    privateKeyPem,
    deviceCertPem,
    clientIdForAssertion
  );
  const url = `https://login.microsoftonline.com/${encodeURIComponent(authority)}/oauth2/token`;
  const body = new URLSearchParams({
    windows_api_version: '2.0',
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    request: assertion,
    client_info: '1',
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`srv_challenge failed (${res.status}): ${text.substring(0, 600)}`);
  }
  const data = (await res.json()) as any;
  // AAD returns session_key_jwe in compact JWE format:
  //   header.encryptedKey.iv.ciphertext.tag
  const jwe: string | undefined = data?.session_key_jwe;
  if (!jwe) throw new Error(`srv_challenge response missing session_key_jwe (keys: ${Object.keys(data).join(', ')})`);
  const parts = jwe.split('.');
  if (parts.length !== 5) {
    throw new Error(`session_key_jwe has ${parts.length} segments, expected 5`);
  }
  const [, encryptedKeyB64, ivB64, ciphertextB64, tagB64] = parts;
  // Step 5: RSA-OAEP-SHA1 unwrap the CEK with our device private key.
  const cek = crypto.privateDecrypt(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha1',
    },
    Buffer.from(encryptedKeyB64, 'base64')
  );
  // Decrypt the session key body with AES-256-GCM using cek.
  const iv = Buffer.from(ivB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', cek, iv);
  decipher.setAuthTag(authTag);
  const sessionKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (sessionKey.length !== 32) {
    throw new Error(`Decrypted session key wrong length: ${sessionKey.length} (expected 32)`);
  }
  return { sessionKey };
}

// ---------------------------------------------------------------------------
// Step 6 — Mint the PRT cookie
// ---------------------------------------------------------------------------

/**
 * NIST SP800-108 KDF in counter mode with HMAC-SHA256 PRF.
 *   K(i) = HMAC(KI, [i]_32 || Label || 0x00 || Context || [L]_32)
 * AAD always uses i=1 and L=256 bits; we collect K(1) directly.
 */
function sp800108DeriveKey(sessionKey: Buffer, ctx: Buffer): Buffer {
  const counter = Buffer.from([0x00, 0x00, 0x00, 0x01]);
  const lenBits = Buffer.from([0x00, 0x00, 0x01, 0x00]); // 256 bits
  const data = Buffer.concat([counter, KDF_LABEL, Buffer.from([0x00]), ctx, lenBits]);
  return crypto.createHmac('sha256', sessionKey).update(data).digest();
}

export interface MintedPrtCookie {
  /** Full `x-ms-RefreshTokenCredential` JWT value. */
  cookie: string;
  /** ISO timestamp of when this cookie was minted. */
  mintedAt: string;
  /** ISO timestamp the cookie should be considered stale (24h is safe). */
  expiresAt: string;
}

export async function fetchAadNonceForPrt(authority: string = 'common'): Promise<string> {
  return fetchAadNonce(authority);
}

export function mintPrtCookie(
  registration: PrtRegistration,
  refreshToken: string,
  requestNonce: string
): MintedPrtCookie {
  const sessionKey = Buffer.from(registration.sessionKeyB64, 'base64');
  if (sessionKey.length !== 32) {
    throw new Error(`Stored session key has wrong length: ${sessionKey.length}`);
  }
  const ctx = crypto.randomBytes(24);
  const signKey = sp800108DeriveKey(sessionKey, ctx);
  const header = {
    alg: 'HS256',
    typ: 'JWT',
    ctx: base64url(ctx),
  };
  const iat = Math.floor(Date.now() / 1000);
  const body = {
    refresh_token: refreshToken,
    is_primary: 'true',
    request_nonce: requestNonce,
    iat,
  };
  const headerB64 = base64url(Buffer.from(JSON.stringify(header), 'utf8'));
  const bodyB64 = base64url(Buffer.from(JSON.stringify(body), 'utf8'));
  const signingInput = `${headerB64}.${bodyB64}`;
  const signature = crypto.createHmac('sha256', signKey).update(signingInput).digest();
  const cookie = `${signingInput}.${base64url(signature)}`;
  const mintedAt = new Date(iat * 1000).toISOString();
  const expiresAt = new Date((iat + 24 * 60 * 60) * 1000).toISOString();
  return { cookie, mintedAt, expiresAt };
}

// ---------------------------------------------------------------------------
// One-shot helper: register + srv_challenge → ready-to-mint PrtRegistration
// ---------------------------------------------------------------------------

export interface RegisterDeviceForPrtParams {
  email: string;
  /** Refresh token from a FOCI client (Office, Outlook, broker, etc.). */
  refreshToken: string;
  /** Original token's client ID, e.g. d3590ed6-52b3-4102-aeff-aad2292ab01c. */
  clientId: string;
  /** Tenant or "common". */
  authority: string;
  /** Optional human-readable device name shown in Entra ID Devices list. */
  deviceDisplayName?: string;
}

export async function registerDeviceForPrt(
  params: RegisterDeviceForPrtParams
): Promise<PrtRegistration> {
  const displayName =
    params.deviceDisplayName || `Watcher-${params.email.replace(/[^a-z0-9.-]+/gi, '_')}`;

  // Step 1: DRS-audience access token (validated). Note this also returns
  // a possibly-rotated refresh token we'll reuse in step 6 (srv_challenge)
  // since AAD often ties the broker FOCI redemption to that rotated RT.
  const drsTok = await acquireDrsAccessToken(
    params.clientId,
    params.authority,
    params.refreshToken
  );

  // The DRS token's `tid` claim is the canonical tenant GUID for this
  // user's home tenant. DRS rejects the request if TargetDomain doesn't
  // resolve to a tenant the bearer is authorized for, so we MUST use the
  // tid out of the token (not a guess based on the email's domain).
  const drsClaims = decodeJwtBody(drsTok.accessToken) || {};
  const targetDomain: string =
    String(drsClaims.tid || '') ||
    (params.email.includes('@') ? params.email.split('@')[1] : 'common');

  // Step 2: keypair + CSR.
  const csr = generateRsaCsr(displayName);

  // Step 3: register the device.
  const reg = await registerDeviceWithDrs(
    drsTok.accessToken,
    csr.csrB64,
    csr.transportKeyB64,
    displayName,
    targetDomain
  );

  // For the srv_challenge call we MUST have a refresh token issued by
  // the broker FOCI client (29d9...). srv_challenge with any other
  // client_id returns AADSTS700019 ("Application ID ... cannot be
  // used or is not authorized"). Fail loudly if FOCI redemption
  // doesn't work — falling back to the original token here just
  // pushes the same error one level up.
  let brokerRefreshToken: string;
  try {
    const broker = await tokenV1(
      BROKER_CLIENT_ID,
      params.authority,
      drsTok.refreshToken,
      'https://graph.windows.net'
    );
    brokerRefreshToken = broker.refreshToken;
  } catch (err) {
    throw new Error(
      `Could not redeem the refresh token at the Microsoft Authentication Broker FOCI client. ` +
      `This usually means the account's original refresh token is not from a FOCI app — ` +
      `re-add the account via Device Code (which uses the Microsoft Office FOCI client) and try again. ` +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Step 4 + 5: srv_challenge → session key. assertion JWT is signed
  // by the device cert + claims client_id=BROKER_CLIENT_ID so AAD
  // evaluates the request against the broker app (which is allowed to
  // mint PRTs).
  const challenge = await srvChallenge(
    params.authority,
    brokerRefreshToken,
    csr.privateKeyPem,
    reg.deviceCertPem,
    BROKER_CLIENT_ID
  );

  return {
    privateKeyPem: csr.privateKeyPem,
    deviceCertPem: reg.deviceCertPem,
    tenantId: reg.tenantId,
    deviceId: reg.deviceId,
    sessionKeyB64: challenge.sessionKey.toString('base64'),
    sessionKeyAcquiredAt: new Date().toISOString(),
    registeredAt: new Date().toISOString(),
  };
}

/**
 * Use an existing PrtRegistration to mint a fresh PRT cookie. Re-runs
 * srv_challenge only if the stored session key is older than `staleMs`
 * (default 12 hours). Returns the cookie + the (possibly rotated)
 * registration so the caller can persist it.
 */
export async function mintPrtCookieForAccount(
  registration: PrtRegistration,
  refreshToken: string,
  authority: string,
  staleMs: number = 12 * 60 * 60 * 1000
): Promise<{ cookie: MintedPrtCookie; registration: PrtRegistration }> {
  let reg = registration;
  const acquiredAt = new Date(reg.sessionKeyAcquiredAt).getTime();
  if (Number.isNaN(acquiredAt) || Date.now() - acquiredAt > staleMs) {
    const fresh = await srvChallenge(
      authority,
      refreshToken,
      reg.privateKeyPem,
      reg.deviceCertPem
    );
    reg = {
      ...reg,
      sessionKeyB64: fresh.sessionKey.toString('base64'),
      sessionKeyAcquiredAt: new Date().toISOString(),
    };
  }
  const nonce = await fetchAadNonce(authority);
  const cookie = mintPrtCookie(reg, refreshToken, nonce);
  return { cookie, registration: reg };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
