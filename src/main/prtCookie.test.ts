/**
 * Offline tests for the deterministic crypto pieces of prtCookie.ts:
 *   - SP800-108 KDF (counter mode, HMAC-SHA256, single block)
 *   - PRT cookie minting: header / body shape, valid HMAC over signing input
 *
 * The networked DRS / srv_challenge pieces are not covered here — those
 * require a real Microsoft tenant and refresh token.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { mintPrtCookie, type PrtRegistration } from './prtCookie';

function base64urlDecode(s: string): Buffer {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function recomputeKdfKey(sessionKey: Buffer, ctx: Buffer): Buffer {
  const counter = Buffer.from([0x00, 0x00, 0x00, 0x01]);
  const lenBits = Buffer.from([0x00, 0x00, 0x01, 0x00]); // 256 bits
  const label = Buffer.from('AzureAD-SecureConversation', 'utf8');
  const data = Buffer.concat([counter, label, Buffer.from([0x00]), ctx, lenBits]);
  return crypto.createHmac('sha256', sessionKey).update(data).digest();
}

test('mintPrtCookie produces a JWT with the expected shape', () => {
  const sessionKey = crypto.randomBytes(32);
  const reg: PrtRegistration = {
    privateKeyPem: 'unused-for-mint',
    deviceCertPem: 'unused-for-mint',
    tenantId: '00000000-0000-0000-0000-000000000001',
    deviceId: '00000000-0000-0000-0000-000000000002',
    sessionKeyB64: sessionKey.toString('base64'),
    sessionKeyAcquiredAt: new Date().toISOString(),
    registeredAt: new Date().toISOString(),
  };
  const refreshToken = '0.AAAA-fake-refresh-token-just-for-shape-checks';
  const requestNonce = 'srv-nonce-XYZ-123';

  const result = mintPrtCookie(reg, refreshToken, requestNonce);
  const parts = result.cookie.split('.');
  assert.equal(parts.length, 3, 'cookie should be a 3-segment JWT');

  const headerJson = JSON.parse(base64urlDecode(parts[0]).toString('utf8'));
  assert.equal(headerJson.alg, 'HS256');
  assert.equal(headerJson.typ, 'JWT');
  assert.ok(typeof headerJson.ctx === 'string' && headerJson.ctx.length > 0, 'header.ctx must be present');
  const ctx = base64urlDecode(headerJson.ctx);
  assert.equal(ctx.length, 24, 'context nonce should be 24 bytes');

  const bodyJson = JSON.parse(base64urlDecode(parts[1]).toString('utf8'));
  assert.equal(bodyJson.refresh_token, refreshToken, 'body should carry the refresh token');
  assert.equal(bodyJson.is_primary, 'true');
  assert.equal(bodyJson.request_nonce, requestNonce);
  assert.ok(typeof bodyJson.iat === 'number' && bodyJson.iat > 0);

  // Verify the HMAC: derive the sign key from the session key + ctx,
  // recompute HMAC over header.body, compare to signature segment.
  const signKey = recomputeKdfKey(sessionKey, ctx);
  const expectedSig = crypto
    .createHmac('sha256', signKey)
    .update(`${parts[0]}.${parts[1]}`)
    .digest();
  assert.equal(parts[2], base64url(expectedSig), 'JWT signature must verify with KDF-derived key');
});

test('mintPrtCookie produces unique ctx (and thus unique signature) per call', () => {
  const sessionKey = crypto.randomBytes(32);
  const reg: PrtRegistration = {
    privateKeyPem: '',
    deviceCertPem: '',
    tenantId: 't',
    deviceId: 'd',
    sessionKeyB64: sessionKey.toString('base64'),
    sessionKeyAcquiredAt: new Date().toISOString(),
    registeredAt: new Date().toISOString(),
  };
  const a = mintPrtCookie(reg, 'rt', 'n');
  const b = mintPrtCookie(reg, 'rt', 'n');
  assert.notEqual(a.cookie, b.cookie, 'two mints should produce different cookies (random ctx)');
});

test('mintPrtCookie rejects malformed session key', () => {
  const reg: PrtRegistration = {
    privateKeyPem: '',
    deviceCertPem: '',
    tenantId: 't',
    deviceId: 'd',
    sessionKeyB64: Buffer.from('too-short').toString('base64'),
    sessionKeyAcquiredAt: new Date().toISOString(),
    registeredAt: new Date().toISOString(),
  };
  assert.throws(() => mintPrtCookie(reg, 'rt', 'n'), /Stored session key has wrong length/);
});
