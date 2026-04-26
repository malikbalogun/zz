export interface ElectronAPI {
  accounts: {
    addViaCredentials: (email: string, password: string) => Promise<unknown>;
    addViaCookies: (email: string, cookies: string) => Promise<unknown>;
    addViaToken: (
      email: string,
      clientId: string,
      authorityEndpoint: string,
      refreshToken: string,
      scopeType?: string
    ) => Promise<unknown>;
    delete: (accountId: string) => Promise<unknown>;
    deleteBulk: (ids: string[]) => Promise<unknown>;
    exportJSON: (accountId: string) => Promise<unknown>;
    exportBulkCSV: (ids: string[]) => Promise<unknown>;
    /**
     * Export the Microsoft OWA session cookies for a token-typed account as a
     * Netscape HTTP Cookie File string. The returned string is round-tripable
     * through the existing cookie-import path.
     */
    exportOwaCookies: (
      accountId: string
    ) => Promise<{
      success: boolean;
      count?: number;
      strongAuthCount?: number;
      strongCount?: number;
      email?: string;
      netscape?: string;
      header?: string;
      domainJson?: string;
      browserSnippet?: string;
      quality?: 'strong' | 'weak';
      error?: string;
    }>;
    /**
     * Snapshot the current token-backed OWA cookies onto the account and copy a
     * ready-to-paste `Cookie:` header to the clipboard for browser devtools /
     * inspect console use.
     */
    snapshotOwaCookies: (
      accountId: string
    ) => Promise<{
      success: boolean;
      count?: number;
      strongAuthCount?: number;
      strongCount?: number;
      email?: string;
      netscape?: string;
      header?: string;
      domainJson?: string;
      browserSnippet?: string;
      quality?: 'strong' | 'weak';
      copiedToClipboard?: boolean;
      error?: string;
    }>;
    /**
     * Re-apply the stored cookie paste for this account to its OWA partition.
     * Returns counts so the UI can show "applied X of Y cookies".
     */
    reapplyCookies: (
      accountId: string
    ) => Promise<{
      success: boolean;
      parsed?: number;
      microsoft?: number;
      applied?: number;
      partition?: string;
      error?: string;
    }>;
    /**
     * Replace the primary auth on a token-typed account after re-authentication.
     * Clears requiresReauth + lastError, marks status active.
     */
    replaceTokenAuth: (
      accountId: string,
      refreshToken: string,
      authorityEndpoint?: string,
      clientId?: string,
      resource?: string,
      scopeType?: string
    ) => Promise<{ success: boolean }>;
    testLogin: (email: string, password: string) => Promise<unknown>;
  };
  tokens: {
    refresh: (accountId: string) => Promise<unknown>;
    refreshBulk: (ids: string[]) => Promise<unknown>;
    /** Snapshot of the background refresh scheduler. */
    refreshStatus: () => Promise<{
      schedulerRunning: boolean;
      intervalMinutes: number;
      lastRunAt: string | null;
      lastReason: string | null;
      lastResult: {
        success: number;
        expired: number;
        failed: number;
        accounts: Array<{
          accountId: string;
          email?: string;
          outcome: 'success' | 'expired' | 'failed';
          error?: string;
        }>;
        errors: Array<{ accountId: string; error: string }>;
      } | null;
    }>;
    /** Trigger an immediate refresh of every active token-typed account. */
    refreshNow: () => Promise<{
      success: boolean;
      ranAt: string;
      result: {
        success: number;
        expired: number;
        failed: number;
        accounts: Array<{
          accountId: string;
          email?: string;
          outcome: 'success' | 'expired' | 'failed';
          error?: string;
        }>;
        errors: Array<{ accountId: string; error: string }>;
      };
    }>;
    exportCSV: () => Promise<unknown>;
    exportJSON: () => Promise<unknown>;
    exportJSONData: (
      accountIds?: string[]
    ) => Promise<{ success: boolean; data?: any; count?: number; error?: string }>;
    importJSON: (filePath: string) => Promise<unknown>;
    importJSONDialog: () => Promise<{
      success: boolean;
      canceled?: boolean;
      count?: number;
      error?: string;
    }>;
  };
  platform: string;
  versions: {
    node: string;
    chrome: string;
    electron: string;
  };
  store: {
    get: (key: string) => Promise<any>;
    set: (key: string, value: any) => Promise<boolean>;
    delete: (key: string) => Promise<boolean>;
  };
  state: {
    get: () => Promise<any>;
    set: (state: any) => Promise<any>;
    update: (updates: any) => Promise<any>;
  };
  safeStorage: {
    encrypt: (plaintext: string) => Promise<string>;
    decrypt: (ciphertext: string) => Promise<string>;
  };
  api: {
    request: (options: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: any;
      /** Main-process fetch timeout (default 15000, max 120000). */
      timeoutMs?: number;
    }) => Promise<{
      ok: boolean;
      status: number;
      headers: Record<string, string>;
      data: any;
    }>;
  };
  microsoft: {
    getAccessToken: (
      clientId: string,
      authority: string,
      refreshToken: string,
      scopeType?: string,
      resource?: string
    ) => Promise<any>;
    startDeviceCode: (clientId?: string, authority?: string) => Promise<any>;
    pollDeviceCode: (deviceCode: string, clientId?: string, authority?: string) => Promise<any>;
  };
  actions: {
    captureCookies: (url: string) => Promise<{ success: boolean; cookies?: string; message?: string }>;
    exchangeCookiesForToken: (
      cookies: string,
      email?: string,
      opts?: { clientId?: string; authority?: string; redirectUri?: string; showWindow?: boolean }
    ) => Promise<any>;
    adminHarvest: (accountId: string) => Promise<any[]>;
    openMailbox: (accountId: string) => Promise<{ success: boolean; error?: string }>;
    /** Panel root `/admin` (org mailboxes), not `/admin/mailbox/...`. */
    openPanelAdmin: (accountId: string) => Promise<{ success: boolean; error?: string }>;
    /** e.g. `admin/connectors`, `admin/smtp` — must be under the panel server origin. */
    openPanelPath: (accountId: string, relativePath: string) => Promise<{ success: boolean; error?: string }>;
    openOutlook: (
      accountId: string,
      options?: { mode?: 'owa' | 'exchangeAdmin'; authPreference?: 'token' | 'cookie' }
    ) => Promise<any>;
    openOwaExternalSignIn: (accountId: string) => Promise<{ success: true; opened: boolean } | { success: false; error?: string }>;
    /** Returns the list of accountIds for which Outlook BrowserWindows are currently open. */
    getOpenOutlookWindows: () => Promise<string[]>;
    telegramSendAlert: (bot: string, message: string) => Promise<{ success: boolean; error?: string }>;
    telegramSendSearchResults: (bot: string, results: any[]) => Promise<{ success: boolean; error?: string }>;
    telegramAccountsNotify: (email: string, via: string) => Promise<{ success: boolean; error?: string }>;
    telegramTest: (bot: string) => Promise<{ success: boolean; error?: string }>;
    importTokens: (filePath: string) => Promise<{ success: boolean; count?: number }>;
    exportTokens: (filePath: string) => Promise<{ success: boolean; path?: string }>;
    exportTokensWithDialog: () => Promise<{ success: boolean; path?: string; count?: number; canceled?: boolean; error?: string }>;
    clearActivity: () => Promise<{ success: boolean }>;
    testTokenExchange: (accountId: string) => Promise<any>;
    testDeviceCodeHighHopes: () => Promise<any>;
    addV2Token: (accountId: string, refreshToken: string, authorityEndpoint?: string, clientId?: string, resource?: string, scopeType?: string) => Promise<any>;
    removeV2Token: (accountId: string) => Promise<any>;
    getOutlookDebugLogs: () => Promise<{ success: boolean; text: string; lines: number }>;
    copyOutlookDebugLogs: () => Promise<{ success: boolean; lines: number; path: string }>;
  };
  oauth: {
    deviceCode: (clientId?: string, authority?: string) => Promise<any>;
    pollToken: (deviceCode: string, clientId?: string, authority?: string) => Promise<any>;
    deviceCodeHighHopes: () => Promise<any>;
    /**
     * Device-code flow that requests Microsoft Graph admin scopes
     * (Directory.Read.All + User.Read.All). Requires global-admin consent.
     */
    deviceCodeAdminScope: (clientId?: string, authority?: string) => Promise<any>;
  };
  /** Microsoft Graph admin-scope enumeration (opt-in). */
  graphAdmin: {
    /** Enumerate every user in the tenant. Follows Graph @odata.nextLink. */
    listUsers: (
      adminRefreshToken: string,
      authority?: string,
      clientId?: string
    ) => Promise<{
      success: boolean;
      users?: Array<{
        id: string;
        mail?: string;
        userPrincipalName?: string;
        displayName?: string;
      }>;
      count?: number;
      refreshTokenRotated?: string;
      error?: string;
      code?: string;
    }>;
  };
  browser: {
    open: (url: string) => Promise<void>;
    openPopup: (url: string) => Promise<void>;
    openLoginPage: (url: string) => Promise<void>;
  };
  files: {
    saveTextWithDialog: (opts: {
      defaultFilename: string;
      content: string;
      filters?: { name: string; extensions: string[] }[];
    }) => Promise<{ ok: true; path: string } | { ok: false }>;
  };
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}