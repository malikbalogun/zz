import { Panel } from '../../types/panel';
import { normalizePanelUrl } from '../utils/url';

const STORE_KEY = 'panels';

export async function encryptPassword(plaintext: string): Promise<string> {
  return window.electron.safeStorage.encrypt(plaintext);
}

export async function decryptPassword(ciphertext: string): Promise<string> {
  return window.electron.safeStorage.decrypt(ciphertext);
}

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

export async function addPanel(
  panel: Omit<Panel, 'id' | 'status' | 'passwordEncrypted'> & { password: string },
) {
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

export async function updatePanel(
  id: string,
  updates: Partial<Panel> & { password?: string },
) {
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
  const { replacePanelTag } = await import('./accountService');

  async function getWebsocketManager() {
    const { websocketManager } = await import('./websocketService');
    return websocketManager;
  }

  const panels = await getPanels();
  const filtered = panels.filter(p => p.id !== id);
  (await getWebsocketManager()).stopForPanel(id);
  await savePanels(filtered);
  try {
    await replacePanelTag(id, 'detached');
  } catch (err) {
    console.error('Failed to replace panel tag for accounts:', err);
  }
}
