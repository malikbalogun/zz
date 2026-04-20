import { UIAccount } from '../../types/store';
import { refreshAccountTokenWithFallback } from './microsoftTokenService';
import { ignoreAccountOnDelete } from './ignoredPanelAccounts';

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
  const account = accounts.find(a => a.id === id);
  const filtered = accounts.filter(a => a.id !== id);
  await saveAccounts(filtered);
  // Remember the (panelId, email) pair so panel sync doesn't immediately
  // re-add the account on the next pass.
  if (account) {
    await ignoreAccountOnDelete(account);
  }
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
  const toIgnore = accounts.filter(a => ids.includes(a.id));
  const filtered = accounts.filter(a => !ids.includes(a.id));
  await saveAccounts(filtered);
  for (const account of toIgnore) {
    await ignoreAccountOnDelete(account);
  }
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

export async function replacePanelTag(panelId: string, newTag: string, clearPanelId = true) {
  const accounts = await getAccounts();
  const panelTag = `panel-${panelId}`;
  for (const account of accounts) {
    if (account.panelId === panelId) {
      // Replace panel tag (production/backup or panel-specific) with newTag
      const tags = account.tags.filter(t => t !== 'production' && t !== 'backup' && t !== panelTag);
      if (!tags.includes(newTag)) tags.push(newTag);
      account.tags = tags;
      if (clearPanelId) {
        account.panelId = undefined;
      }
    }
  }
  await saveAccounts(accounts);
}

/**
 * Merge duplicate accounts (same email) into a single account.
 * Prefers accounts with a panelId, then most recently added.
 * Merges tags, auth, panelId, and removes detached tag if panelId present.
 * Deletes extra duplicate accounts.
 */
export async function mergeDuplicateAccounts(): Promise<void> {
  const accounts = await getAccounts();
  const byEmail = new Map<string, UIAccount[]>();
  
  // Group by normalized email
  for (const account of accounts) {
    const key = account.email.trim().toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, []);
    byEmail.get(key)!.push(account);
  }
  
  const toDelete = new Set<string>();
  const pendingUpdates: Array<{ id: string; updates: Partial<UIAccount> }> = [];
  
  for (const [_email, group] of byEmail) {
    if (group.length <= 1) continue;
    
    // Determine primary account
    // Prefer account with panelId, then most recent added date
    const sorted = [...group].sort((a, b) => {
      if (a.panelId && !b.panelId) return -1;
      if (!a.panelId && b.panelId) return 1;
      // Both have panelId or both don't: compare added date (newer first)
      const aDate = new Date(a.added).getTime();
      const bDate = new Date(b.added).getTime();
      return bDate - aDate;
    });
    
    const primary = sorted[0];
    const duplicates = sorted.slice(1);
    
    // Merge tags from duplicates (union)
    let mergedTags = [...primary.tags];
    for (const dup of duplicates) {
      for (const tag of dup.tags) {
        if (!mergedTags.includes(tag)) mergedTags.push(tag);
      }
    }
    
    // Remove detached tag if primary has panelId
    if (primary.panelId) {
      mergedTags = mergedTags.filter(t => t !== 'detached');
      // Ensure panel tag exists
      const panelTag = `panel-${primary.panelId}`;
      if (!mergedTags.includes(panelTag)) mergedTags.push(panelTag);
    }
    
    // Merge auth: prefer token over cookie/credential? Keep primary's auth.
    // But if primary lacks auth and duplicate has token, adopt token.
    let mergedAuth = primary.auth;
    for (const dup of duplicates) {
      if (!mergedAuth && dup.auth) {
        mergedAuth = dup.auth;
      } else if (mergedAuth?.type === 'cookie' && dup.auth?.type === 'token') {
        mergedAuth = dup.auth; // token is superior
      }
    }
    
    // Merge panelId: if primary lacks panelId but duplicate has one, adopt it
    let mergedPanelId = primary.panelId;
    if (!mergedPanelId) {
      for (const dup of duplicates) {
        if (dup.panelId) {
          mergedPanelId = dup.panelId;
          break;
        }
      }
    }
    
    // Prepare updates if any changes
    const updatesObj: Partial<UIAccount> = {};
    if (JSON.stringify(mergedTags.sort()) !== JSON.stringify(primary.tags.sort())) {
      updatesObj.tags = mergedTags;
    }
    if (mergedAuth !== primary.auth) {
      updatesObj.auth = mergedAuth;
    }
    if (mergedPanelId !== primary.panelId) {
      updatesObj.panelId = mergedPanelId;
    }
    
    if (Object.keys(updatesObj).length > 0) {
      pendingUpdates.push({ id: primary.id, updates: updatesObj });
    }
    
    // Mark duplicates for deletion
    for (const dup of duplicates) {
      toDelete.add(dup.id);
    }
  }
  
  // Apply updates
  for (const { id, updates } of pendingUpdates) {
    await updateAccount(id, updates);
  }
  
  // Delete duplicates
  if (toDelete.size > 0) {
    await bulkDeleteAccounts([...toDelete]);
  }
}