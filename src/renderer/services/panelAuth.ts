import { Panel } from '../../types/panel';
import { normalizePanelUrl } from '../utils/url';
import { getPanels, decryptPassword, updatePanel } from './panelStore';

async function getWebsocketManager() {
  const { websocketManager } = await import('./websocketService');
  return websocketManager;
}

export async function testPanelConnection(
  url: string,
  username: string,
  password: string,
): Promise<string> {
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
        'Stored panel password can no longer be decrypted on this machine/session. Open Panels, edit this panel, and save the password again.',
      );
    }
    throw error;
  }
  try {
    const token = await testPanelConnection(panel.url, panel.username, password);
    const updated = await updatePanel(panelId, {
      token,
      tokenExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      status: 'connected',
      error: undefined,
    });
    (await getWebsocketManager()).startForPanel(panelId, updated.url).catch(err =>
      console.error(`Failed to start WebSocket for panel ${panelId}:`, err),
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
