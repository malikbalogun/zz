/**
 * Microsoft OAuth refresh for Graph vs Outlook (OWA / EWS-style) delegated tokens.
 * Office-issued refresh tokens typically require the v2 endpoint with
 * https://outlook.office.com/.default — v1 /oauth2/token + resource often fails for those RTs.
 */

export type TokenRefreshResult = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  scope: string;
  idToken?: string;
};

/** Extract tenant segment for login.microsoftonline.com URLs, or return the value as-is. */
export function normalizeAuthorityTenant(authority: string): string {
  if (!authority || typeof authority !== 'string') return 'common';
  const a = authority.trim();
  if (a.includes('login.microsoftonline.com')) {
    try {
      const withProto = a.includes('://') ? a : `https://${a}`;
      const u = new URL(withProto);
      const seg = u.pathname.split('/').filter(Boolean)[0];
      if (seg) return seg;
    } catch {
      /* ignore */
    }
  }
  return a;
}

const OUTLOOK_V2_DEFAULT_SCOPE = 'https://outlook.office.com/.default openid profile offline_access';

async function postTokenEndpoint(
  url: string,
  body: URLSearchParams,
  label: string,
  fallbackRefreshToken: string,
  attempt: number = 1
): Promise<TokenRefreshResult> {
  const controller = new AbortController();
  // 60s timeout per attempt — AAD's token endpoint is occasionally slow
  // and 30s was tripping spurious AbortError → NETWORK_ERROR cascades.
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body,
      signal: controller.signal,
    } as any);
    clearTimeout(timeoutId);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.error === 'invalid_grant') {
        const err = new Error('REFRESH_TOKEN_EXPIRED');
        (err as any).code = 'REFRESH_TOKEN_EXPIRED';
        throw err;
      }
      if (data.error_description && String(data.error_description).includes('AADSTS65002')) {
        const err = new Error('INVALID_CLIENT');
        (err as any).code = 'INVALID_CLIENT';
        throw err;
      }
      throw new Error(`${data.error_description || data.error || response.status}`);
    }
    const data = await response.json();
    console.log('[Microsoft] Token refreshed', {
      flow: label,
      expires_in: data.expires_in,
      has_new_refresh: !!data.refresh_token,
      has_id_token: !!data.id_token,
    });
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || fallbackRefreshToken,
      expiresIn: data.expires_in,
      tokenType: data.token_type || 'Bearer',
      scope: data.scope || '',
      idToken: data.id_token,
    };
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.code === 'REFRESH_TOKEN_EXPIRED' || error.code === 'INVALID_CLIENT') throw error;
    const isNetwork =
      error.name === 'AbortError' ||
      error.code === 'NETWORK_ERROR' ||
      error.message?.includes('fetch') ||
      error.message?.includes('network') ||
      error.message?.includes('ECONNRESET') ||
      error.message?.includes('ETIMEDOUT') ||
      error.message?.includes('ENETUNREACH');
    if (isNetwork) {
      // Retry transient network failures up to 3 attempts with exponential
      // backoff — AAD's token endpoint occasionally drops connections
      // (especially when many refreshes fire at once on app startup) and
      // a single retry recovers most of the time.
      if (attempt < 3) {
        const delay = 750 * Math.pow(2, attempt - 1); // 750ms, 1500ms
        console.warn(`[Microsoft] ${label}: network error attempt ${attempt}; retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        return postTokenEndpoint(url, body, label, fallbackRefreshToken, attempt + 1);
      }
      const err = new Error('NETWORK_ERROR');
      (err as any).code = 'NETWORK_ERROR';
      throw err;
    }
    throw error;
  }
}

async function refreshGraphV2(clientId: string, tenant: string, refreshToken: string): Promise<TokenRefreshResult> {
  const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    scope: 'Mail.Read Mail.Send offline_access',
  });
  const r = await postTokenEndpoint(url, body, 'graph-v2', refreshToken);
  return {
    ...r,
    scope: r.scope || 'Mail.Read Mail.Send offline_access',
  };
}

async function refreshOutlookV2Default(clientId: string, tenant: string, refreshToken: string): Promise<TokenRefreshResult> {
  const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    scope: OUTLOOK_V2_DEFAULT_SCOPE,
  });
  const r = await postTokenEndpoint(url, body, 'outlook-v2-.default', refreshToken);
  return {
    ...r,
    scope: r.scope || OUTLOOK_V2_DEFAULT_SCOPE,
  };
}

async function refreshV1Resource(
  clientId: string,
  tenant: string,
  refreshToken: string,
  resource: string
): Promise<TokenRefreshResult> {
  const url = `https://login.microsoftonline.com/${tenant}/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    resource,
  });
  const r = await postTokenEndpoint(url, body, `v1-resource:${resource}`, refreshToken);
  return {
    ...r,
    scope: r.scope || 'https://outlook.office.com/EWS.AccessAsUser.All offline_access',
  };
}

/**
 * @param scopeType `graph` — Mail.Read v2 flow; `ews` — Outlook/Exchange delegated (tries v2 OWA .default, then v1 resources).
 */
export async function refreshMicrosoftToken(
  clientId: string,
  authority: string,
  refreshToken: string,
  scopeType: string = 'graph',
  resource?: string
): Promise<TokenRefreshResult> {
  const tenant = normalizeAuthorityTenant(authority);

  if (scopeType === 'graph') {
    return refreshGraphV2(clientId, tenant, refreshToken);
  }

  if (scopeType !== 'ews') {
    console.warn('[Microsoft] Unknown scopeType; using graph flow:', scopeType);
    return refreshGraphV2(clientId, tenant, refreshToken);
  }

  const exchangeGuid = resource || '00000002-0000-0ff1-ce00-000000000000';
  const attempts: Array<{ label: string; run: () => Promise<TokenRefreshResult> }> = [
    { label: 'outlook-v2-.default', run: () => refreshOutlookV2Default(clientId, tenant, refreshToken) },
    { label: 'v1-https://outlook.office.com', run: () => refreshV1Resource(clientId, tenant, refreshToken, 'https://outlook.office.com') },
    { label: `v1-${exchangeGuid}`, run: () => refreshV1Resource(clientId, tenant, refreshToken, exchangeGuid) },
  ];

  const errors: string[] = [];
  for (const { label, run } of attempts) {
    try {
      const result = await run();
      console.log('[Microsoft] Outlook/EWS refresh succeeded via', label);
      return result;
    } catch (e: any) {
      if (e.code === 'REFRESH_TOKEN_EXPIRED') throw e;
      errors.push(`${label}: ${e.message || String(e)}`);
      console.warn('[Microsoft] Refresh path failed:', label, e.message);
    }
  }

  throw new Error(`Outlook token refresh failed (tried v2 .default + v1 resources): ${errors.join(' | ')}`);
}
