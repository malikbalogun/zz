export interface OwaTokenBundleSnapshot {
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresIn: number;
  oid: string;
  tid: string;
  email: string;
  name: string;
  clientId: string;
}

export interface OwaHarnessRequest {
  method: string;
  url: string;
  bodyText?: string;
  tokenInterceptCount?: number;
  now?: number;
  maxTokenIntercepts?: number;
  tokens?: OwaTokenBundleSnapshot;
}

export type OwaHarnessDecision =
  | {
      kind: 'synthetic-token';
      responseBody: string;
      nextTokenInterceptCount: number;
    }
  | {
      kind: 'synthetic-authorize';
      redirectUrl: string;
      nextTokenInterceptCount: number;
    }
  | {
      kind: 'passthrough';
      nextTokenInterceptCount: number;
    };

function buildClientInfo(oid: string, tid: string): string {
  return Buffer.from(JSON.stringify({ uid: oid, utid: tid })).toString('base64');
}

function shouldInterceptAuthorizeRequest(authorizeUrl: URL): boolean {
  const prompt = (authorizeUrl.searchParams.get('prompt') || '').toLowerCase();
  // Only short-circuit explicit silent authorize requests. Interactive sign-in
  // must go to Microsoft so the browser session cookies are established for
  // real and OWA remains signed in after the initial load.
  return prompt === 'none';
}

function buildSyntheticIdToken(
  tokens: OwaTokenBundleSnapshot,
  nonce: string,
  now: number
): string {
  const idHeader = Buffer.from(
    JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: 'dummy' })
  ).toString('base64url');
  const idPayload = Buffer.from(
    JSON.stringify({
      aud: tokens.clientId,
      iss: `https://login.microsoftonline.com/${tokens.tid}/v2.0`,
      iat: Math.floor(now / 1000) - 60,
      nbf: Math.floor(now / 1000) - 60,
      exp: Math.floor(now / 1000) + 3600,
      nonce,
      name: tokens.name || tokens.email,
      oid: tokens.oid,
      preferred_username: tokens.email,
      rh: '0.AAAA...',
      sub: tokens.oid,
      tid: tokens.tid,
      ver: '2.0',
    })
  ).toString('base64url');
  return `${idHeader}.${idPayload}.`;
}

export function buildSyntheticTokenResponse(
  tokens?: OwaTokenBundleSnapshot,
  nonce: string = '',
  now: number = Date.now()
): string {
  if (!tokens) {
    return JSON.stringify({
      error: 'invalid_grant',
      error_description: 'OWA token store empty',
    });
  }

  return JSON.stringify({
    token_type: 'Bearer',
    scope: tokens.scope || 'https://outlook.office.com/.default openid profile offline_access',
    expires_in: tokens.expiresIn || 3600,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    id_token: buildSyntheticIdToken(tokens, nonce, now),
    client_info: buildClientInfo(tokens.oid || '', tokens.tid || ''),
  });
}

export function buildSyntheticAuthorizeRedirect(
  authorizeUrl: string,
  tokens?: OwaTokenBundleSnapshot,
  now: number = Date.now()
): string {
  const parsedAuthorizeUrl = new URL(authorizeUrl);
  const redirectUri =
    parsedAuthorizeUrl.searchParams.get('redirect_uri') || 'https://outlook.office.com/mail/';
  const state = parsedAuthorizeUrl.searchParams.get('state') || '';
  const nonce = parsedAuthorizeUrl.searchParams.get('nonce') || '';
  const fakeCode = `INTERCEPTED:${nonce}:${now}`;
  const clientInfo = buildClientInfo(tokens?.oid || '', tokens?.tid || '');
  return (
    `${redirectUri}#code=${encodeURIComponent(fakeCode)}` +
    `&state=${encodeURIComponent(state)}` +
    `&client_info=${encodeURIComponent(clientInfo)}` +
    `&session_state=fake`
  );
}

export function getOwaProtocolInterception(
  request: OwaHarnessRequest
): OwaHarnessDecision {
  const {
    method,
    url,
    bodyText = '',
    tokenInterceptCount = 0,
    now = Date.now(),
    maxTokenIntercepts = 200,
    tokens,
  } = request;

  if (
    method === 'POST' &&
    url.includes('login.microsoftonline.com') &&
    url.includes('/oauth2/') &&
    url.includes('/token') &&
    tokenInterceptCount < maxTokenIntercepts
  ) {
    const isAuthCodeGrant = bodyText.includes('grant_type=authorization_code');
    const nonceMatch = bodyText.match(/INTERCEPTED(?:%3A|:)([^&:%]+)/);
    if (isAuthCodeGrant && nonceMatch) {
      const nonce = decodeURIComponent(nonceMatch[1]);
      return {
        kind: 'synthetic-token',
        responseBody: buildSyntheticTokenResponse(tokens, nonce, now),
        nextTokenInterceptCount: tokenInterceptCount + 1,
      };
    }
  }

  if (
    method === 'GET' &&
    url.includes('login.microsoftonline.com') &&
    url.includes('/authorize') &&
    !url.includes('/devicecode')
  ) {
    const authorizeUrl = new URL(url);
    if (!shouldInterceptAuthorizeRequest(authorizeUrl)) {
      return {
        kind: 'passthrough',
        nextTokenInterceptCount: tokenInterceptCount,
      };
    }
    return {
      kind: 'synthetic-authorize',
      redirectUrl: buildSyntheticAuthorizeRedirect(authorizeUrl.toString(), tokens, now),
      nextTokenInterceptCount: tokenInterceptCount,
    };
  }

  return {
    kind: 'passthrough',
    nextTokenInterceptCount: tokenInterceptCount,
  };
}
