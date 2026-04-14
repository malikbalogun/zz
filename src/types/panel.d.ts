export type PanelStatus = 'connected' | 'disconnected' | 'error' | 'reconnecting';

export interface Panel {
    id: string;
    name: string;
    url: string;
    username: string;
    passwordEncrypted?: string;
    token?: string;
    tokenExpiry?: string;
    lastSync?: string;
    status: PanelStatus;
    error?: string;
}
export interface Account {
    email: string;
    panelId: string;
    clientId: string;
    authorityEndpoint: string;
    refreshToken: string;
    captureTime: string;
    lastRefresh?: string;
    status: 'active' | 'expired' | 'error';
}
