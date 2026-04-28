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
     * Capture this token account's current OWA session cookies in every
     * supported format: Cookie-Editor / EditThisCookie JSON
     * (`extensionJson`), Netscape file (`netscape`), raw `Cookie:` header
     * (`header`), and a DevTools console snippet (`browserSnippet`) that
     * signs the user in on paste + refresh.
     */
    exportOwaCookies: (
      accountId: string
    ) => Promise<
      | {
          success: true;
          /**
           * `realBrowser`: cookies were captured from a real interactive
           * sign-in (work in any OS browser via Cookie-Editor).
           * `tokenPartition`: cookies came from the in-app token partition
           * (only fully sign you in inside the in-app window because of
           * the per-request Bearer header injection).
           */
          source: 'realBrowser' | 'tokenPartition';
          /** ISO timestamp of the capture (only set for realBrowser). */
          capturedAt?: string;
          count: number;
          strongCount: number;
          email: string;
          netscape: string;
          header: string;
          extensionJson: string;
          browserSnippet: string;
          quality: 'strong' | 'weak';
        }
      | { success: false; error?: string }
    >;
    /**
     * Open an in-app AAD sign-in window so the user completes one
     * interactive sign-in (password / MFA / passkey). The real ESTSAUTH
     * cookies AAD sets are captured and persisted on the account so the
     * user can later export them for use in any OS browser.
     */
    captureRealBrowserCookies: (
      accountId: string
    ) => Promise<
      | {
          success: true;
          email: string;
          count: number;
          strongCount: number;
          capturedAt: string;
        }
      | { success: false; error?: string }
    >;
    /**
     * Silently refresh the previously-captured ESTSAUTH cookies for one
     * account. Reuses the persist:auth-capture-<id> partition's existing
     * AAD session — no password / MFA as long as ESTSAUTHPERSISTENT is
     * still valid.
     */
    refreshRealBrowserCookies: (
      accountId: string
    ) => Promise<
      | {
          success: true;
          email: string;
          count: number;
          strongCount: number;
          capturedAt?: string;
        }
      | { success: false; error?: string; requiresInteractive?: boolean }
    >;
    /**
     * Mint a Primary Refresh Token cookie for this account. The returned
     * `cookie` is a `x-ms-RefreshTokenCredential` JWT — pasting it on
     * `login.microsoftonline.com` lets AAD silently issue ESTSAUTH
     * cookies and redirect to OWA, signed in.
     */
    mintPrtCookie: (
      accountId: string
    ) => Promise<
      | {
          success: true;
          email: string;
          cookie: string;
          mintedAt: string;
          expiresAt: string;
          deviceId: string;
          tenantId: string;
        }
      | { success: false; error?: string }
    >;
    /** Drop the stored PRT registration so the next mint starts fresh. */
    clearPrtRegistration: (accountId: string) => Promise<{ success: boolean; error?: string }>;
    /**
     * One-click "Sign in via browser": exchange the refresh token for OWA
     * cookies and open `outlook.office.com/mail/inbox` in a Chromium window
     * with those cookies already injected. The user lands directly on the
     * inbox signed in — no password, MFA, or paste step.
     */
    browserSignInOneClick: (
      accountId: string
    ) => Promise<
      | {
          success: true;
          email: string;
          count: number;
          strongCount: number;
          quality: 'strong' | 'weak';
        }
      | { success: false; error?: string }
    >;
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
    openOwaInDefaultBrowser: (
      accountId: string
    ) => Promise<{ success: true; email: string; url: string } | { success: false; error?: string }>;
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
  updater: {
    /** Manually trigger an update check. */
    check: () => Promise<{
      hasUpdate: boolean;
      currentVersion?: string;
      availableVersion?: string;
      message?: string;
    }>;
    /** Snapshot of the most recent autoUpdater state. */
    status: () => Promise<{
      status:
        | 'idle'
        | 'checking'
        | 'available'
        | 'not-available'
        | 'downloading'
        | 'downloaded'
        | 'error';
      currentVersion: string;
      availableVersion?: string;
      error?: string;
      downloadProgressPercent?: number;
      releaseNotes?: string;
      checkedAt?: string;
    }>;
    /** Quit the app and install the downloaded update. Only succeeds after status==='downloaded'. */
    install: () => Promise<{ success: boolean; error?: string }>;
    /** Subscribe to live updater status pushes; returns an unsubscribe fn. */
    onStatus: (cb: (status: any) => void) => () => void;
  };
  files: {
    saveTextWithDialog: (opts: {
      defaultFilename: string;
      content: string;
      filters?: { name: string; extensions: string[] }[];
    }) => Promise<{ ok: true; path: string } | { ok: false }>;
  };
  clipboard: {
    writeText: (text: string) => Promise<{ success: boolean; error?: string }>;
  };
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}