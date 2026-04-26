export interface UIAccount {
  id: string;
  email: string;
  name?: string;
  panelId?: string; // if added via panel sync
  added: string; // ISO date
  status: 'active' | 'expired' | 'error';
  tags: string[]; // tag IDs (system or user)
  avatarColor?: string;
  // auth data (union)
  auth?: {
    type: 'token';
    clientId?: string;
    authorityEndpoint?: string;
    refreshToken?: string;
    scopeType?: 'graph' | 'ews';
    resource?: string;
    /**
     * Optional Microsoft Graph refresh token captured under admin scopes
     * (Directory.Read.All / User.Read.All). When set, the admin enumeration
     * UI can list every user in the tenant via Graph `/users`.
     * Stored separately so the regular EWS-scope auth keeps working
     * independently.
     */
    adminGraphRefreshToken?: string;
  } | {
    type: 'cookie';
    /** Encrypted cookie paste (renderer) or main-process `cookiesEncrypted` — both supported when loading OWA. */
    cookies?: string;
    cookiesEncrypted?: string;
  } | {
    type: 'credential';
    username: string;
    passwordEncrypted: string;
  };
  lastRefresh?: string;
  /** Last token/API error message (e.g. after health check). */
  lastError?: string;
  /**
   * Set true when the most recent refresh failed with `invalid_grant`
   * (Microsoft revoked the refresh token). The UI surfaces a "Sign in
   * again" CTA that re-runs the device-code flow.
   */
  requiresReauth?: boolean;
  notes?: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  icon?: string;
  type: 'system' | 'user';
  count?: number;
  locked?: boolean; // system tags cannot be edited
}

export interface MonitoringRule {
  id: string;
  accountId: string;
  keywords: string[];
  folders: string[];
  tags: string[];
  status: 'active' | 'paused';
  scenarioType?: 'keyword' | 'folder' | 'keyword-in-folder' | 'token';
  lastRun?: string;
  lastAlert?: string;
  lastError?: string;
  lastErrorAt?: string;
  /** Set when the rule is created — lower bound for listening. */
  listenStartedAt?: string;
  /** Future-only: mail received after listenStartedAt / lastRun (monitoring does not scan mailbox history). */
  timeScope?: 'live';
  /** Match keywords in messages from anyone vs only from listed senders. */
  senderScope?: 'all' | 'specific';
  /** When senderScope is specific: partial addresses or domains to match (case-insensitive). */
  senderAddresses?: string[];
}

export interface MonitoringAlert {
  id: string;
  ruleId: string;
  accountId: string;
  emailId?: string;
  subject: string;
  matchedKeyword: string;
  timestamp: string;
  read: boolean;
  /** Short excerpt around the keyword match (subject + body preview). */
  snippet?: string;
  webLink?: string;
  /** When the email was received (Graph ReceivedDateTime), ISO string. */
  messageReceivedAt?: string;
}

export interface SearchJob {
  id: string;
  keywords: string[];
  dateRange: { start?: string; end?: string };
  folders: string[];
  accountIds: string[];
  status: 'queued' | 'running' | 'completed' | 'failed';
  results?: SearchResult[];
  telegramAlert: boolean;
  senderFilter?: string;
  createdAt: string;
  completedAt?: string;
  lastError?: string;
}

export interface SearchResult {
  id: string;
  jobId: string;
  accountId: string;
  subject: string;
  snippet: string;
  date: string;
  /** Display name of folder (or "All folders"). */
  folder: string;
  /** Keywords from the search job (for display). */
  keywords?: string[];
  /** Outlook web link (Graph WebLink) so the row can open the message in OWA. */
  webLink?: string;
  /** Graph message id, kept for future deep-link / pull-from-mailbox flows. */
  emailId?: string;
}

export type AutoReplyScope = 'global' | 'account';

/** What to do when the rule matches (reply sends a template; others use Graph like Security). */
export type AutoReplyActionType = 'reply' | 'delete' | 'junk' | 'mark_read';

export type AutoReplyTriggerType =
  | 'all'
  | 'sender'
  | 'keyword'
  | 'thread'
  | 'subject'
  | 'conversation';

export interface AutoReplyRule {
  id: string;
  name: string;
  enabled: boolean;
  /** `global` = all token mailboxes; `account` = one mailbox (accountId). */
  scope: AutoReplyScope;
  accountId?: string;
  action: AutoReplyActionType;
  triggerType: AutoReplyTriggerType;
  /** Match text (sender contains, keyword in subject+preview, thread/subject contains, etc.). */
  triggerValue: string;
  /** Set when using “anchor” from Inbox/Sent: match mail in the same conversation thread. */
  referenceMessageId?: string;
  referenceConversationId?: string;
  referenceSubjectHint?: string;
  /** Must be true when triggerType is `all` (matches every Inbox message — use carefully). */
  ackAllInboxRisk?: boolean;
  delayMinutes: number;
  templateSubject: string;
  templateBody: string;
  createdAt: string;
  updatedAt: string;
  lastMatchedAt?: string;
  lastSentAt?: string;
  matchCount?: number;
}

export interface AutoReplyEvent {
  id: string;
  ruleId: string;
  accountId: string;
  messageId: string;
  action: 'matched' | 'queued' | 'sent' | 'failed';
  detail: string;
  timestamp: string;
}

export interface FollowUpTask {
  id: string;
  title: string;
  description?: string;
  owner?: string;
  status: 'pending' | 'in_progress' | 'done' | 'urgent';
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
  accountId?: string;
  emailId?: string;
  emailSubject?: string;
}

export interface Settings {
  telegram: {
    monitoring?: {
      token: string;
      chatId: string;
      enabled: boolean;
      keywordOnly?: boolean; // only alert on keyword matches
    };
    accounts?: {
      token: string;
      chatId: string;
      enabled: boolean;
      notifyTokens?: boolean; // notify new tokens
    };
    search?: {
      token: string;
      chatId: string;
      enabled: boolean;
      includeSnippets?: boolean; // include email snippets
    };
    panel?: {
      token: string;
      chatId: string;
      backupChatId?: string;
      enabled: boolean;
      notifyAiCritical?: boolean;
      notifySecurityActions?: boolean;
      notifyAutoReplySends?: boolean;
      notifyCampaignProgress?: boolean;
    };
  };
  sync: {
    autoSync: boolean;
    intervalMinutes: number;
    autoReconnect?: boolean; // auto‑reconnect on launch
    realTimeWebSocket?: boolean; // enable real-time sync via WebSocket
  };
  refresh: {
    autoRefresh: boolean;
    intervalMinutes: number;
    tagId?: string; // autorefresh tag
  };
  monitoring: {
    enabled: boolean;
    intervalMinutes: number;
  };
  storage: {
    encryptionPassword?: string; // currently set password (hashed?)
    localCredentials: boolean; // store credentials locally
  };
  appearance: {
    darkMode: boolean;
    sidebarCollapsed: boolean;
  };
  tags: {
    userTags: Tag[]; // only user tags
  };
  dashboard: {
    maxEvents: number; // 5,10,20,50
    autoRefresh: number; // seconds, 0 = off
    showTokenRefreshed: boolean;
    showMonitoringAlerts: boolean;
    showPanelSynced: boolean;
    showTokenExpired: boolean;
    showPanelConnection: boolean;
    showSearchResults: boolean;
    showAccountAdded: boolean;
  };
  debug?: {
    /**
     * When true, getOutlookService() returns the in-memory MockOutlookService
     * (no network calls; deterministic fixtures). Useful for offline dev /
     * UI smoke testing without burning Microsoft tokens.
     */
    useMockOutlookApi?: boolean;
    /** Legacy name for the same flag, honoured for back-compat. */
    useMockGraphApi?: boolean;
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
  };
  /** AI inbox threat analysis (OpenAI uses main-process proxied HTTP; key stored in local settings). */
  ai?: {
    analysisMode?: 'heuristic' | 'openai' | 'anthropic';
    openaiApiKey?: string;
    openaiModel?: string;
    /** Optional: fetch full message body and append text for richer analysis context. */
    useFullBodyForAnalysis?: boolean;
  };
  /** Inbox security rules: Graph actions (junk / delete / read) on matching mail. */
  security?: {
    filterEnabled: boolean;
    /** 0 = only when you click Apply; >0 = also every N minutes on all token mailboxes. */
    autoApplyIntervalMinutes?: number;
  };
  /** Background auto-reply / auto-action runner (separate from Security rules). */
  autoReply?: {
    engineEnabled: boolean;
    /** 0 = off; otherwise run inbox scan every N minutes. */
    intervalMinutes?: number;
  };
  microsoftOAuth?: {
    clientId: string;
    tenantId?: string;
    redirectUri?: string;
    scopes?: string[];
  };
  /** In-app message body translator (LibreTranslate-compatible endpoint). */
  translation?: {
    enabled?: boolean;
    /** ISO 639-1 target language (e.g. 'en', 'es', 'fr'). Default 'en'. */
    targetLang?: string;
    /** LibreTranslate-compatible POST endpoint. Defaults to the public Argos instance. */
    endpoint?: string;
    /** Optional API key for self-hosted / paid instances. Sent as `api_key`. */
    apiKey?: string;
  };
  version?: string;
  platform?: string;
  lastUpdated?: string;
}