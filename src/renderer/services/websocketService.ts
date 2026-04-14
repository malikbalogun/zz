import { getSettings } from './settingsService';
import { getPanels } from './panelService';
import { syncPanelAccounts } from './accountSyncService';

export type WebSocketStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface WebSocketConnection {
  ws: WebSocket;
  url: string;
  panelId: string;
  status: WebSocketStatus;
  reconnectAttempts: number;
}

/**
 * Manages WebSocket connections to panels for real‑time token capture notifications.
 * Singleton – use `websocketManager`.
 */
class WebSocketManager {
  private connections: Map<string, WebSocketConnection> = new Map();
  private readonly maxReconnectAttempts = 10;
  private readonly baseReconnectDelay = 2000; // ms

  /** Always derive /ws/tokens from the panel's https origin + path — never pass a ws: URL here. */
  private buildWsUrlFromHttpPanelUrl(panelUrl: string): string {
    const raw = panelUrl.trim();
    let httpUrl = raw;
    if (raw.startsWith('ws://') || raw.startsWith('wss://')) {
      const u = new URL(raw);
      const path = u.pathname.replace(/\/ws\/tokens\/?$/i, '').replace(/\/+$/, '') || '';
      httpUrl = `https://${u.host}${path}`;
    }
    if (!httpUrl.startsWith('http://') && !httpUrl.startsWith('https://')) {
      httpUrl = 'https://' + httpUrl;
    }
    const url = new URL(httpUrl);
    const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const basePath = url.pathname.replace(/\/$/, '');
    return `${wsProtocol}//${url.host}${basePath}/ws/tokens`;
  }

  /**
   * Start WebSocket connection for a specific panel.
   * If a connection already exists, it will be replaced.
   */
  async startForPanel(panelId: string, panelUrl: string): Promise<void> {
    // Ensure real‑time WebSocket is enabled in settings
    const settings = await getSettings();
    if (!settings.sync.realTimeWebSocket) {
      console.log(`Real‑time WebSocket disabled, skipping connection for panel ${panelId}`);
      return;
    }

    // Stop any existing connection
    this.stopForPanel(panelId);

    // Build WebSocket URL once from the panel's HTTP(S) base URL only.
    const wsUrl = this.buildWsUrlFromHttpPanelUrl(panelUrl);
    console.log(`Connecting WebSocket for panel ${panelId}: ${wsUrl}`);

    const ws = new WebSocket(wsUrl);
    const conn: WebSocketConnection = {
      ws,
      url: wsUrl,
      panelId,
      status: 'connecting',
      reconnectAttempts: 0,
    };
    this.connections.set(panelId, conn);

    ws.onopen = () => this.handleOpen(panelId);
    ws.onclose = (event) => this.handleClose(panelId, event);
    ws.onerror = (error) => this.handleError(panelId, error);
    ws.onmessage = (event) => this.handleMessage(panelId, event);
  }

  /**
   * Stop WebSocket connection for a panel and clear any reconnect timer.
   */
  stopForPanel(panelId: string): void {
    const conn = this.connections.get(panelId);
    if (!conn) return;

    console.log(`Stopping WebSocket for panel ${panelId}`);
    conn.ws.onopen = null;
    conn.ws.onclose = null;
    conn.ws.onerror = null;
    conn.ws.onmessage = null;
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
      conn.ws.close(1000, 'Normal closure');
    }
    this.connections.delete(panelId);
    // Clear any pending reconnect timer
    const timer = (conn as any)._reconnectTimer;
    if (timer) clearTimeout(timer);
  }

  /**
   * Return current WebSocket status for a panel.
   */
  getStatus(panelId: string): WebSocketStatus {
    const conn = this.connections.get(panelId);
    return conn ? conn.status : 'disconnected';
  }

  /**
   * Start WebSocket connections for all currently connected panels.
   * Called on app startup and when real‑time WebSocket setting is enabled.
   */
  async startAll(): Promise<void> {
    const settings = await getSettings();
    if (!settings.sync.realTimeWebSocket) {
      console.log('Real‑time WebSocket disabled globally');
      return;
    }
    const panels = await getPanels();
    for (const panel of panels) {
      if (panel.status === 'connected' && panel.token) {
        await this.startForPanel(panel.id, panel.url);
      }
    }
  }

  /**
   * Stop all WebSocket connections.
   */
  stopAll(): void {
    for (const panelId of this.connections.keys()) {
      this.stopForPanel(panelId);
    }
  }

  /**
   * Update connections based on current settings and panel states.
   * Call after settings change or panel authentication.
   */
  async refreshConnections(): Promise<void> {
    const settings = await getSettings();
    const panels = await getPanels();

    // Disconnect panels that are no longer connected or real‑time is disabled
    for (const [panelId, _conn] of this.connections.entries()) {
      const panel = panels.find(p => p.id === panelId);
      if (!panel || panel.status !== 'connected' || !panel.token || !settings.sync.realTimeWebSocket) {
        this.stopForPanel(panelId);
      }
    }

    // Connect panels that should be connected but aren't
    for (const panel of panels) {
      if (panel.status === 'connected' && panel.token && settings.sync.realTimeWebSocket) {
        if (!this.connections.has(panel.id)) {
          await this.startForPanel(panel.id, panel.url);
        }
      }
    }
  }

  // --- Event handlers ---

  private handleOpen(panelId: string): void {
    console.log(`WebSocket connected for panel ${panelId}`);
    const conn = this.connections.get(panelId);
    if (conn) {
      conn.status = 'connected';
      conn.reconnectAttempts = 0;
    }
  }

  private handleClose(panelId: string, event: CloseEvent): void {
    console.log(`WebSocket closed for panel ${panelId}: code=${event.code}, reason=${event.reason}`);
    const conn = this.connections.get(panelId);
    if (!conn) return;

    conn.status = 'disconnected';
    // If closure was abnormal (not intentional) and we haven't exceeded max attempts, schedule reconnect
    if (event.code !== 1000 && conn.reconnectAttempts < this.maxReconnectAttempts) {
      const delay = this.baseReconnectDelay * Math.pow(1.5, conn.reconnectAttempts);
      console.log(`Scheduling reconnect for panel ${panelId} in ${delay}ms (attempt ${conn.reconnectAttempts + 1})`);
      const timer = setTimeout(() => {
        void (async () => {
          try {
            const panels = await getPanels();
            const panel = panels.find(p => p.id === panelId);
            if (!panel) {
              this.connections.delete(panelId);
              return;
            }
            await this.startForPanel(panelId, panel.url);
          } catch (err) {
            console.error(`Failed to reconnect WebSocket for panel ${panelId}:`, err);
          }
        })();
      }, delay);
      (conn as any)._reconnectTimer = timer;
      conn.reconnectAttempts++;
    } else {
      // Either normal closure or too many failures – give up
      this.connections.delete(panelId);
    }
  }

  private handleError(panelId: string, error: Event): void {
    console.error(`WebSocket error for panel ${panelId}:`, error);
    const conn = this.connections.get(panelId);
    if (conn) {
      conn.status = 'error';
    }
  }

  private async handleMessage(panelId: string, event: MessageEvent): Promise<void> {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'token') {
        console.log(`Token captured event from panel ${panelId}:`, data.data);
        // Trigger a sync for this panel to pull the new token
        await syncPanelAccounts(panelId);
      }
    } catch (err) {
      console.error('Failed to process WebSocket message:', err);
    }
  }
}

// Singleton instance
export const websocketManager = new WebSocketManager();