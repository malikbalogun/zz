import { UIAccount } from '../../types/store';
import { refreshAccountTokenWithFallback } from './microsoftTokenService';

const STORE_KEY = 'accounts';

function emitAccountsChanged() {
  // Dispatch custom event that App.tsx listens for
  window.dispatchEvent(new CustomEvent('accounts-changed'));
}

export async function getAccounts(): Promise<UIAccount[]> {
  const accounts = await window.electron.store.get(STORE_KEY);
  return Array.isArray(accounts) ? accounts : [];
}

export async function saveAccounts(accounts: UIAccount[]) {
  await window.electron.store.set(STORE_KEY, accounts);
  emitAccountsChanged();
}

/** Same mailbox slot: normalized email + panel (null/undefined treated as null). */
export function isSameAccountSlot(a: Pick<UIAccount, 'email' | 'panelId'>, b: Pick<UIAccount, 'email' | 'panelId'>): boolean {
  const ap = a.panelId ?? null;
  const bp = b.panelId ?? null;
  return a.email.trim().toLowerCase() === b.email.trim().toLowerCase() && ap === bp;
}

/**
 * Insert or merge when the same email + panel already exists (avoids duplicate rows from harvest / re-import).
 */
export async function addAccountWithDedupe(account: Omit<UIAccount, 'id'>): Promise<UIAccount> {
  const accounts = await getAccounts();
  const idx = accounts.findIndex(a => isSameAccountSlot(a, account));
  if (idx !== -1) {
    const prev = accounts[idx];
    return updateAccount(prev.id, {
      ...account,
      added: prev.added,
    });
  }
  return addAccount(account);
}

export async function addAccount(account: Omit<UIAccount, 'id'>) {
  const accounts = await getAccounts();
  const newAccount: UIAccount = {
    ...account,
    id: crypto.randomUUID(),
  };
  accounts.push(newAccount);
  await saveAccounts(accounts);
  try {
    const settings = await window.electron.store.get('settings');
    if (settings?.telegram?.accounts?.enabled) {
      void window.electron.actions.telegramAccountsNotify(newAccount.email, 'App / sync');
    }
  } catch {
    /* optional Telegram */
  }
  return newAccount;
}

export async function updateAccount(id: string, updates: Partial<UIAccount>) {
  const accounts = await getAccounts();
  const index = accounts.findIndex(a => a.id === id);
  if (index === -1) throw new Error('Account not found');
  accounts[index] = { ...accounts[index], ...updates };
  await saveAccounts(accounts);
  return accounts[index];
}

export async function deleteAccount(id: string) {
  const accounts = await getAccounts();
  const filtered = accounts.filter(a => a.id !== id);
  await saveAccounts(filtered);
}

export async function bulkUpdateAccounts(ids: string[], updates: Partial<UIAccount>) {
  const accounts = await getAccounts();
  for (const account of accounts) {
    if (ids.includes(account.id)) {
      Object.assign(account, updates);
    }
  }
  await saveAccounts(accounts);
}

export async function bulkDeleteAccounts(ids: string[]) {
  const accounts = await getAccounts();
  const filtered = accounts.filter(a => !ids.includes(a.id));
  await saveAccounts(filtered);
}

/**
 * Refresh each token account and persist status (active / expired / error).
 * Call on Account Health load and after user re-auth.
 */
export async function runTokenHealthCheckForAll(): Promise<void> {
  const accounts = await getAccounts();
  for (const account of accounts) {
    await runTokenHealthCheckForOne(account.id);
  }
}

/**
 * Refresh and persist health state for one token account.
 * Useful for manual per-account re-check in UI.
 */
export async function runTokenHealthCheckForOne(accountId: string): Promise<UIAccount | null> {
  const accounts = await getAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account || account.auth?.type !== 'token') return null;
  try {
    const partial = await refreshAccountTokenWithFallback(account, account.panelId);
    const updates: Partial<UIAccount> = { lastError: '' };
    if (partial.status) updates.status = partial.status;
    if (partial.lastRefresh) updates.lastRefresh = partial.lastRefresh;
    if (partial.auth && account.auth?.type === 'token') {
      updates.auth = { ...account.auth, ...partial.auth };
    }
    return await updateAccount(account.id, updates);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return await updateAccount(account.id, {
      status: 'error',
      lastError: msg,
      lastRefresh: new Date().toISOString(),
    });
  }
}

export async function replacePanelTag(panelId: string, newTag: string) {
  const accounts = await getAccounts();
  const panelTag = `panel-${panelId}`;
  for (const account of accounts) {
    if (account.panelId === panelId) {
      // Replace panel tag (production/backup or panel-specific) with newTag
      const tags = account.tags.filter(t => t !== 'production' && t !== 'backup' && t !== panelTag);
      tags.push(newTag);
      account.tags = tags;
    }
  }
  await saveAccounts(accounts);
}