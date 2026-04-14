export interface Panel {
  id: string;
  name: string;
  url: string;               // e.g., https://panel.example.com
  username: string;          // admin username
  passwordEncrypted?: string; // encrypted password (safeStorage)
  token?: string;            // JWT token after login
  tokenExpiry?: string;      // ISO timestamp when token expires
  lastSync?: string;         // ISO timestamp of last successful sync
  status: 'connected' | 'disconnected' | 'error';
  error?: string;
}

export interface Account {
  email: string;
  panelId: string;
  clientId: string;
  authorityEndpoint: string;
  refreshToken: string;      // encrypted locally
  captureTime: string;
  lastRefresh?: string;
  status: 'active' | 'expired' | 'error';
  resource?: string;
  scopeType?: 'ews' | 'graph' | 'custom';
}