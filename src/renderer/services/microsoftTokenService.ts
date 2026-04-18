import { UIAccount } from '../../types/store';

export interface TokenRefreshResult {
  accessToken: string;
  refreshToken: string; // new refresh token (may be same as previous)
  expiresIn: number;
  tokenType: string;
  scope: string;
}

export interface TokenRefreshError extends Error {
  code?: 'REFRESH_TOKEN_EXPIRED' | 'NETWORK_ERROR' | 'INVALID_CLIENT' | 'UNKNOWN';
}

/**
 * Refresh a Microsoft OAuth2 token directly using the v2 endpoint.
 * @param clientId OAuth2 client ID (first‑party app ID)
 * @param authority Authority endpoint: 'common' or tenant ID (e.g., 'consumers', 'organizations', or a tenant GUID)
 * @param refreshToken Current refresh token
 * @returns Fresh tokens
 * @throws {TokenRefreshError} with code 'REFRESH_TOKEN_EXPIRED' if the token is expired/revoked
 */
export async function refreshMicrosoftToken(
  clientId: string,
  authority: string,
  refreshToken: string,
  scopeType?: string,
  resource?: string
): Promise<TokenRefreshResult> {
  console.log('[Microsoft] refreshMicrosoftToken called via IPC', {
    clientId: clientId?.substring(0, 8),
    authority,
    refreshTokenLength: refreshToken?.length,
    scopeType: scopeType || 'graph',
  });
  try {
    const result = await window.electron.microsoft.getAccessToken(
      clientId,
      authority,
      refreshToken,
      scopeType,
      resource
    );
    console.log('[Microsoft] IPC result:', { success: result.success, error: result.error, code: result.code });
    if (!result.success) {
      const err = new Error(result.error || 'Token refresh failed') as TokenRefreshError;
      err.code = result.code as any;
      throw err;
    }
    // Map main‑process response to TokenRefreshResult
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken || refreshToken, // keep old if no new one
      expiresIn: result.expiresIn,
      tokenType: result.tokenType || 'Bearer',
      scope: result.scope || 'https://outlook.office.com/EWS.AccessAsUser.All offline_access',
    };
  } catch (error: any) {
    console.error('[Microsoft] IPC error:', error);
    // If IPC threw (should not happen), preserve existing error handling
    if (error.code) throw error;
    // Network errors (IPC failure)
    if (error.message?.includes('fetch') || error.message?.includes('network')) {
      const err = new Error(`Network error: ${error.message}`) as TokenRefreshError;
      err.code = 'NETWORK_ERROR';
      throw err;
    }
    // Wrap unknown errors
    const err = new Error(`Token refresh failed: ${error.message}`) as TokenRefreshError;
    err.code = 'UNKNOWN';
    throw err;
  }
}

/**
 * Refresh a stored account's token using direct Microsoft OAuth.
 * Updates the account's auth object and lastRefresh timestamp.
 * @param account The account with token‑based auth
 * @returns Updated account data (without saving)
 */
export async function refreshAccountTokenDirect(account: UIAccount): Promise<Partial<UIAccount>> {
  if (account.auth?.type !== 'token') {
    throw new Error('Account does not have token‑based auth');
  }
  
  const { clientId, authorityEndpoint, refreshToken } = account.auth;
  if (!clientId || !authorityEndpoint || !refreshToken) {
    throw new Error('Missing required auth fields (clientId, authorityEndpoint, refreshToken)');
  }

  const result = await refreshMicrosoftToken(
    clientId,
    authorityEndpoint,
    refreshToken,
    account.auth.scopeType || 'ews',
    account.auth.resource
  );
  
  // Prepare updated auth object
  const updatedAuth = {
    ...account.auth,
    clientId,
    authorityEndpoint,
    refreshToken: result.refreshToken,
  };
  
  return {
    auth: updatedAuth,
    lastRefresh: new Date().toISOString(),
    status: 'active' as const,
  };
}

/**
 * Attempt direct refresh; if network fails, fall back to panel export.
 * @param account The account to refresh
 * @param panelId Optional panel ID for fallback
 * @returns Updated account data
 */
export async function refreshAccountTokenWithFallback(
  account: UIAccount,
  panelId?: string
): Promise<Partial<UIAccount>> {
  try {
    return await refreshAccountTokenDirect(account);
  } catch (error: any) {
    // If network error and we have a panel, fall back to panel export
    if (error.code === 'NETWORK_ERROR' && panelId) {
      console.warn(`Direct refresh network error for ${account.email}, falling back to panel export`);
      // Return empty update; caller should handle panel fallback
      return {};
    }
    // If token expired, mark as expired
    if (error.code === 'REFRESH_TOKEN_EXPIRED') {
      console.warn(`Refresh token expired for ${account.email}`);
      return {
        status: 'expired' as const,
        lastRefresh: new Date().toISOString(),
      };
    }
    // Re‑throw other errors
    throw error;
  }
}