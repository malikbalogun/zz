import { UIAccount } from '../../types/store';

const STORE_KEY = 'ignoredPanelAccounts';

type IgnoredEntry = {
  panelId: string; // empty string if unknown
  email: string;
};

async function getIgnoredEntries(): Promise<IgnoredEntry[]> {
  const entries = await window.electron.store.get(STORE_KEY);
  return Array.isArray(entries) ? entries : [];
}

export async function getAllIgnoredEntries(): Promise<IgnoredEntry[]> {
  return getIgnoredEntries();
}

async function saveIgnoredEntries(entries: IgnoredEntry[]) {
  await window.electron.store.set(STORE_KEY, entries);
}

export async function addIgnoredPanelAccount(panelId: string, email: string) {
  const entries = await getIgnoredEntries();
  // Avoid duplicate
  if (!entries.some(e => e.panelId === panelId && e.email === email)) {
    entries.push({ panelId, email });
    await saveIgnoredEntries(entries);
  }
}

export async function removeIgnoredPanelAccount(panelId: string, email: string) {
  const entries = await getIgnoredEntries();
  const filtered = entries.filter(e => !(e.panelId === panelId && e.email === email));
  if (filtered.length !== entries.length) {
    await saveIgnoredEntries(filtered);
  }
}

export async function isIgnoredPanelAccount(panelId: string, email: string): Promise<boolean> {
  const entries = await getIgnoredEntries();
  return entries.some(e => e.panelId === panelId && e.email === email);
}

export async function getIgnoredEmailsForPanel(panelId: string): Promise<string[]> {
  const entries = await getIgnoredEntries();
  return entries.filter(e => e.panelId === panelId).map(e => e.email);
}

/**
 * When an account is deleted, call this to prevent its re‑addition from panel sync.
 * If the account has a panelId, we ignore that specific panel.
 * If panelId is undefined but the account email exists in any panel's ignored list, we keep those entries.
 */
export async function ignoreAccountOnDelete(account: UIAccount) {
  if (account.panelId) {
    await addIgnoredPanelAccount(account.panelId, account.email);
  }
  // If no panelId, we cannot associate with a panel, but we could still ignore for all panels?
  // For now, do nothing.
}

/**
 * Remove ignore entries for an account (e.g., when user wants to allow sync again).
 */
export async function unignoreAccount(account: UIAccount) {
  if (account.panelId) {
    await removeIgnoredPanelAccount(account.panelId, account.email);
  }
  // Also remove any entries with empty panelId? Not needed.
}