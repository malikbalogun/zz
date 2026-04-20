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
import { isIgnoredPanelAccount } from './ignoredPanelAccounts';

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

  // Filter out accounts the user has explicitly deleted on this panel so a
  // delete + sync round-trip doesn't keep re-adding the same row. The ignore
  // list is populated by `ignoreAccountOnDelete` in accountService.
  const filteredRemoteAccounts: typeof remoteAccounts = [];
  for (const remote of remoteAccounts) {
    if (await isIgnoredPanelAccount(panelId, remote.email)) {
      console.log(`Skipping ignored account ${remote.email} for panel ${panelId}`);
      continue;
    }
    filteredRemoteAccounts.push(remote);
  }

  // Panel-specific tag (unique per panel)
  const panelTag = `panel-${panel.id}`;
  const settings = await getSettings();
  const autoRefreshTagId = settings.refresh.tagId || 'autorefresh';

  const existing = await getAccounts();
  const added: UIAccount[] = [];

  // Collect emails for batch export
  const emails = filteredRemoteAccounts.map(r => r.email);
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

  for (const remote of filteredRemoteAccounts) {
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
/**
 * Add an account using panel-stored credentials. We:
 *   1. Re-authenticate the linked panel using its stored Bearer credentials.
 *   2. Try to immediately pull a Microsoft refresh token for this mailbox
 *      via panelService.exportToken — if the panel has already captured one,
 *      the new account is stored as a `token` auth straight away (so it can
 *      use the cheap direct-OAuth refresh path).
 *   3. If no token is available yet, fall back to a `credential` auth that
 *      stores the encrypted password so a later
 *      refreshAccountTokenViaCredential() call can do the upgrade once the
 *      panel has captured a sign-in.
 */
export async function addAccountViaCredentials(
  panelId: string,
  email: string,
  password: string
): Promise<UIAccount> {
  const panel = await authenticatePanel(panelId);

  const settings = await getSettings();
  const autoRefreshTagId = settings.refresh.tagId || 'autorefresh';
  const baseTags = ['credential', `panel-${panel.id}`];
  if (autoRefreshTagId) baseTags.push(autoRefreshTagId);

  // Try to upgrade straight to a token auth if the panel has captured one.
  try {
    const tokenData: any = await exportToken(panel, email);
    const clientId = tokenData?.clientId || tokenData?.client_id;
    const refreshToken = tokenData?.refreshToken || tokenData?.refresh_token;
    if (clientId && refreshToken) {
      const authorityEndpoint =
        tokenData?.authorityEndpoint || tokenData?.authority_endpoint || 'https://login.microsoftonline.com/common';
      const scopeStr = typeof tokenData?.scope === 'string' ? tokenData.scope : '';
      const scopeRaw = (tokenData?.scopeType || tokenData?.scope_type || '').toString().toLowerCase();
      const scopeType: 'graph' | 'ews' =
        scopeRaw === 'graph' || scopeRaw === 'ews'
          ? (scopeRaw as 'graph' | 'ews')
          : scopeStr.includes('https://graph.microsoft.com')
            ? 'graph'
            : 'ews';
      const resource: string =
        tokenData?.resource ||
        (scopeStr.includes('https://outlook.office.com')
          ? 'https://outlook.office.com'
          : '00000002-0000-0ff1-ce00-000000000000');
      return addAccountWithDedupe({
        email,
        name: email.split('@')[0],
        panelId,
        added: new Date().toISOString(),
        status: 'active',
        tags: baseTags.filter(t => t !== 'credential'), // it's now a token account
        auth: {
          type: 'token',
          clientId,
          authorityEndpoint,
          refreshToken,
          scopeType,
          resource,
        },
      });
    }
  } catch (err) {
    // exportToken may 404 when no token is captured yet — fine, we fall back
    // to the credential auth below and let the user trigger a refresh later.
    console.warn(
      `[addAccountViaCredentials] No captured token for ${email} yet; storing credential auth as fallback:`,
      err
    );
  }

  const passwordEncrypted = await encryptPassword(password);
  return addAccountWithDedupe({
    email,
    name: email.split('@')[0],
    panelId,
    added: new Date().toISOString(),
    status: 'active',
    tags: baseTags,
    auth: {
      type: 'credential',
      username: email,
      passwordEncrypted,
    },
  });
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
      // Token expired – mark account expired
      updates = {
        status: 'expired',
        lastRefresh: new Date().toISOString(),
      };
    } else {
      // Other error (invalid client, etc.) – re-throw
      throw error;
    }
  }
  
  const updated = await updateAccount(accountId, updates);
  return updated;
}

/**
 * Refresh a credential-typed account by re-authenticating its linked panel
 * (using the stored panel password — `panelService.authenticatePanel` does
 * the decrypt + login dance) and pulling the freshly-captured Microsoft
 * refresh token via `panelService.exportToken`. On success the account is
 * upgraded to a `token` auth so subsequent refreshes can use the cheaper
 * direct OAuth path (`refreshAccountTokenDirect`).
 *
 * Throws with a helpful message when the account isn't credential-typed,
 * isn't linked to a panel, or the panel hasn't captured a token yet.
 */
export async function refreshAccountTokenViaCredential(accountId: string): Promise<UIAccount> {
  const accounts = await getAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account) throw new Error('Account not found');

  if (account.auth?.type !== 'credential') {
    throw new Error('Account does not have credential auth');
  }
  if (!account.panelId) {
    throw new Error(
      'Credential refresh requires a linked panel (the panel performs the actual sign-in). Link this account to a panel and try again.'
    );
  }

  // Step 1 — re-authenticate the panel. authenticatePanel decrypts the
  // stored panel password and POSTs /api/auth/login to get a fresh Bearer.
  const panel = await authenticatePanel(account.panelId);

  // Step 2 — pull the latest Microsoft refresh token the panel has
  // captured for this mailbox. The panel signs the user in on its end and
  // exposes the resulting OAuth token via /api/mailbox/{email}/export-token.
  let tokenData: any;
  try {
    tokenData = await exportToken(panel, account.email);
  } catch (err: any) {
    // Map common 404 to a clearer message — tokens are only available once
    // the panel has actually captured a sign-in for that mailbox.
    const msg = String(err?.message || err);
    if (msg.includes('404')) {
      throw new Error(
        `Panel has no captured token for ${account.email} yet. The user must sign in through the panel at least once before credential refresh can pull a Microsoft token.`
      );
    }
    throw err;
  }

  const clientId = tokenData?.clientId || tokenData?.client_id;
  const authorityEndpoint =
    tokenData?.authorityEndpoint || tokenData?.authority_endpoint || 'https://login.microsoftonline.com/common';
  const refreshToken = tokenData?.refreshToken || tokenData?.refresh_token;
  if (!clientId || !refreshToken) {
    throw new Error('Panel token export response was missing clientId or refresh_token.');
  }

  // Step 3 — upgrade the account from credential auth to token auth so
  // refreshAccountToken() can take over with the direct OAuth refresh path.
  const scopeStr = typeof tokenData?.scope === 'string' ? tokenData.scope : '';
  const scopeRaw = (tokenData?.scopeType || tokenData?.scope_type || '').toString().toLowerCase();
  const scopeType: 'graph' | 'ews' =
    scopeRaw === 'graph' || scopeRaw === 'ews'
      ? (scopeRaw as 'graph' | 'ews')
      : scopeStr.includes('https://graph.microsoft.com')
        ? 'graph'
        : 'ews';
  const resource: string =
    tokenData?.resource ||
    (scopeStr.includes('https://outlook.office.com')
      ? 'https://outlook.office.com'
      : '00000002-0000-0ff1-ce00-000000000000');

  const updated = await updateAccount(accountId, {
    auth: {
      type: 'token',
      clientId,
      authorityEndpoint,
      refreshToken,
      scopeType,
      resource,
    },
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
 * For **token (Microsoft) accounts**: opens **Microsoft Exchange admin center**
 * in an in-app BrowserWindow that reuses the account's OWA partition (so the
 * Microsoft session — MSAL cache + OAuth interceptor + Bearer header
 * injection — applies and the user lands signed in instead of being asked to
 * authenticate again in their default browser).
 *
 * For **panel-linked** accounts, opens the panel `/admin` UI in-app as before.
 */
export async function openPanelAdminDashboard(accountId: string): Promise<void> {
  const accounts = await getAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (account?.auth?.type === 'token') {
    await window.electron.actions.openOutlook(accountId, { mode: 'exchangeAdmin' });
    return;
  }
  await window.electron.actions.openPanelAdmin(accountId);
}
