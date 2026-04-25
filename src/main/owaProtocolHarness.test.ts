import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSyntheticAuthorizeRedirect,
  buildSyntheticTokenResponse,
  getOwaProtocolInterception,
  type OwaTokenBundleSnapshot,
} from './owaProtocolHarness';

const sampleTokens: OwaTokenBundleSnapshot = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  clientId: 'client-id-123',
  oid: 'oid-123',
  tid: 'tid-123',
  email: 'user@example.com',
  name: 'Example User',
  expiresIn: 3600,
  scope: 'https://outlook.office.com/.default openid profile offline_access',
};

test('buildSyntheticTokenResponse returns invalid_grant when token store is empty', () => {
  const payload = JSON.parse(buildSyntheticTokenResponse(undefined, 'nonce-1'));
  assert.equal(payload.error, 'invalid_grant');
  assert.equal(payload.error_description, 'OWA token store empty');
});

test('buildSyntheticTokenResponse preserves nonce in synthetic id token', () => {
  const payload = JSON.parse(buildSyntheticTokenResponse(sampleTokens, 'nonce-xyz'));
  assert.equal(payload.access_token, 'access-token');
  assert.equal(payload.refresh_token, 'refresh-token');
  assert.equal(payload.client_info, Buffer.from(JSON.stringify({ uid: 'oid-123', utid: 'tid-123' })).toString('base64'));

  const idTokenParts = String(payload.id_token).split('.');
  assert.equal(idTokenParts.length, 3);
  const idPayload = JSON.parse(Buffer.from(idTokenParts[1], 'base64url').toString('utf8'));
  assert.equal(idPayload.nonce, 'nonce-xyz');
  assert.equal(idPayload.aud, 'client-id-123');
  assert.equal(idPayload.preferred_username, 'user@example.com');
});

test('buildSyntheticAuthorizeRedirect emits INTERCEPTED code and client_info', () => {
  const redirect = buildSyntheticAuthorizeRedirect(
    'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?redirect_uri=https%3A%2F%2Foutlook.office.com%2Fmail%2F&state=abc123&nonce=nonce-777',
    sampleTokens,
    1700000000000
  );

  const parsed = new URL(redirect);
  assert.equal(parsed.origin + parsed.pathname, 'https://outlook.office.com/mail/');
  const hash = new URLSearchParams(parsed.hash.slice(1));
  assert.equal(hash.get('state'), 'abc123');
  assert.equal(hash.get('session_state'), 'fake');
  assert.equal(
    hash.get('client_info'),
    Buffer.from(JSON.stringify({ uid: 'oid-123', utid: 'tid-123' })).toString('base64')
  );
  assert.equal(hash.get('code'), 'INTERCEPTED:nonce-777:1700000000000');
});

test('getOwaProtocolInterception intercepts synthetic authorization-code token exchange', () => {
  const result = getOwaProtocolInterception({
    url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    method: 'POST',
    bodyText: 'grant_type=authorization_code&code=INTERCEPTED%3Anonce-abc%3A1700000000000',
    tokenInterceptCount: 3,
    tokens: sampleTokens,
  });

  assert.equal(result.kind, 'synthetic-token');
  if (result.kind !== 'synthetic-token') {
    throw new Error('expected synthetic-token interception');
  }
  assert.equal(result.nextTokenInterceptCount, 4);
  const payload = JSON.parse(result.responseBody);
  const idTokenParts = String(payload.id_token).split('.');
  const idPayload = JSON.parse(Buffer.from(idTokenParts[1], 'base64url').toString('utf8'));
  assert.equal(idPayload.nonce, 'nonce-abc');
});

test('getOwaProtocolInterception ignores real token refresh flows', () => {
  const result = getOwaProtocolInterception({
    url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    method: 'POST',
    bodyText: 'grant_type=refresh_token&refresh_token=real-token',
    tokenInterceptCount: 1,
    tokens: sampleTokens,
  });

  assert.equal(result.kind, 'passthrough');
  assert.equal(result.nextTokenInterceptCount, 1);
});

test('getOwaProtocolInterception intercepts authorize requests but skips device-code endpoints', () => {
  const intercepted = getOwaProtocolInterception({
    url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?redirect_uri=https%3A%2F%2Foutlook.office.com%2Fmail%2F&state=s1&nonce=n1&prompt=none',
    method: 'GET',
    tokenInterceptCount: 0,
    tokens: sampleTokens,
    now: 1700000000000,
  });
  assert.equal(intercepted.kind, 'synthetic-authorize');
  if (intercepted.kind !== 'synthetic-authorize') {
    throw new Error('expected synthetic-authorize interception');
  }
  assert.ok(intercepted.redirectUrl.includes('INTERCEPTED%3An1%3A1700000000000'));

  const deviceCode = getOwaProtocolInterception({
    url: 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode',
    method: 'GET',
    tokenInterceptCount: 0,
    tokens: sampleTokens,
  });
  assert.equal(deviceCode.kind, 'passthrough');
});

test('getOwaProtocolInterception lets interactive authorize requests pass through', () => {
  const interactivePrompt = getOwaProtocolInterception({
    url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?redirect_uri=https%3A%2F%2Foutlook.office.com%2Fmail%2F&state=s1&nonce=n1&prompt=login',
    method: 'GET',
    tokenInterceptCount: 0,
    tokens: sampleTokens,
    now: 1700000000000,
  });
  assert.equal(interactivePrompt.kind, 'passthrough');

  const accountSelection = getOwaProtocolInterception({
    url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?redirect_uri=https%3A%2F%2Foutlook.office.com%2Fmail%2F&state=s1&nonce=n1&prompt=select_account',
    method: 'GET',
    tokenInterceptCount: 0,
    tokens: sampleTokens,
    now: 1700000000000,
  });
  assert.equal(accountSelection.kind, 'passthrough');

  const noPrompt = getOwaProtocolInterception({
    url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?redirect_uri=https%3A%2F%2Foutlook.office.com%2Fmail%2F&state=s1&nonce=n1',
    method: 'GET',
    tokenInterceptCount: 0,
    tokens: sampleTokens,
    now: 1700000000000,
  });
  assert.equal(noPrompt.kind, 'passthrough');
});

test('getOwaProtocolInterception stops synthetic token interception after cap', () => {
  const result = getOwaProtocolInterception({
    url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    method: 'POST',
    bodyText: 'grant_type=authorization_code&code=INTERCEPTED%3Anonce-cap%3A1',
    tokenInterceptCount: 200,
    tokens: sampleTokens,
  });

  assert.equal(result.kind, 'passthrough');
  assert.equal(result.nextTokenInterceptCount, 200);
});
