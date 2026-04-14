import crypto from 'crypto';
import { BrowserWindow, session as electronSession } from 'electron';
import type { Session } from 'electron';
import {
  parseCookiePaste,
  filterMicrosoftRelatedCookies,
  cookieToSetUrl,
  type ParsedCookie,
} from '../shared/cookieFormat';
import { diagnoseMicrosoftAuthError, type MicrosoftAuthDiagnostic } from '../shared/microsoftAuthDiagnostics';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export async function applyParsedCookiesToSession(sess: Session, cookies: ParsedCookie[]): Promise<number> {
  let n = 0;
  for (const c of cookies) {
    if (!c.name) continue;
    const url = cookieToSetUrl(c);
    try {
      await sess.cookies.set({
        url,
        name: c.name,
        value: c.value,
        path: c.path?.startsWith('/') ? c.path : `/${c.path || ''}`,
        secure: c.secure !== false,
        httpOnly: /ESTS|SID|session/i.test(c.name),
        sameSite: 'no_restriction',
        expirationDate: c.expirationDate && c.expirationDate > 0 ? c.expirationDate : undefined,
      });
      n++;
    } catch (e) {
      console.warn('[cookieImport] cookies.set failed', c.name, url, (e as Error).message);
    }
  }
  return n;
}

function extractAuthCodeFromUrl(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl.split('#')[0]);
    const q = u.searchParams.get('code');
    if (q) return q;
  } catch {
    /* ignore */
  }
  const hash = pageUrl.includes('#') ? pageUrl.split('#')[1] : '';
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const code = params.get('code');
  return code || null;
}

export type CookieExchangeResult = {
  success: boolean;
  refreshToken?: string;
  accessToken?: string;
  idToken?: string;
  clientId?: string;
  tenant?: string;
  scope?: string;
  error?: string;
  diagnostics?: string;
  authDiagnostic?: MicrosoftAuthDiagnostic;
};

/**
 * Apply pasted cookies, open OAuth authorize with PKCE, capture code from redirect, exchange for tokens.
 */
export async function runCookieToTokenConversion(opts: {
  rawPaste: string;
  emailHint?: string;
  clientId: string;
  authority: string;
  redirectUri: string;
  /** Show browser window so user can complete MFA if cookies are insufficient */
  showWindow: boolean;
}): Promise<CookieExchangeResult> {
  const parsedAll = parseCookiePaste(opts.rawPaste);
  if (!parsedAll.length) {
    return { success: false, error: 'No cookies parsed (empty or unsupported format).', diagnostics: 'paste_netscape_json_or_header' };
  }
  const msCookies = filterMicrosoftRelatedCookies(parsedAll);
  const toApply = msCookies.length ? msCookies : parsedAll;
  if (!toApply.length) {
    return { success: false, error: 'No Microsoft-related cookies found after filter.', diagnostics: `parsed=${parsedAll.length}` };
  }

  const tenant = (opts.authority || 'common').replace(/^\//, '').trim() || 'common';
  const { verifier, challenge } = generatePkce();
  const scope = encodeURIComponent('openid offline_access https://outlook.office.com/.default');
  const redirect = opts.redirectUri.trim();
  const authUrl =
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize` +
    `?client_id=${encodeURIComponent(opts.clientId)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    `&scope=${scope}` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    `&code_challenge_method=S256` +
    (opts.emailHint ? `&login_hint=${encodeURIComponent(opts.emailHint)}` : '');

  const partition = `temp:cookie-convert-${Date.now()}`;
  const sess = electronSession.fromPartition(partition, { cache: false });

  const applied = await applyParsedCookiesToSession(sess, toApply);
  if (applied === 0) {
    return { success: false, error: 'Failed to apply any cookies to session.', diagnostics: `attempted=${toApply.length}` };
  }

  return new Promise((resolve) => {
    let settled = false;
    let exchangingCode: string | null = null;
    let win: BrowserWindow | null = null;
    const timeout = setTimeout(() => {
      finish({
        success: false,
        error: 'Timed out waiting for OAuth redirect (cookies may be expired or MFA required).',
        diagnostics: 'timeout_120s',
      });
    }, 120_000);

    const finish = (r: CookieExchangeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        win?.destroy();
      } catch {
        /* ignore */
      }
      resolve(r);
    };

    win = new BrowserWindow({
      width: 520,
      height: 720,
      show: opts.showWindow,
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    const tryExchangeCode = async (code: string) => {
      if (settled) return;
      if (exchangingCode && exchangingCode === code) return;
      exchangingCode = code;
      try {
        const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
        const body = new URLSearchParams({
          client_id: opts.clientId,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirect,
          code_verifier: verifier,
        });
        const res = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        const data = (await res.json()) as Record<string, unknown>;
        if (!res.ok) {
          const err = String(data.error_description || data.error || res.status);
          const authDiagnostic = diagnoseMicrosoftAuthError(err);
          finish({
            success: false,
            error: `Token exchange failed: ${err}`,
            diagnostics: `http_${res.status}`,
            authDiagnostic,
          });
          return;
        }
        const refresh = typeof data.refresh_token === 'string' ? data.refresh_token : undefined;
        if (!refresh) {
          finish({
            success: false,
            error: 'No refresh_token in token response (try device code flow).',
            diagnostics: 'missing_refresh_token',
          });
          return;
        }
        finish({
          success: true,
          refreshToken: refresh,
          accessToken: typeof data.access_token === 'string' ? data.access_token : undefined,
          idToken: typeof data.id_token === 'string' ? data.id_token : undefined,
          clientId: opts.clientId,
          tenant,
          scope: typeof data.scope === 'string' ? data.scope : undefined,
        });
      } catch (e) {
        finish({ success: false, error: (e as Error).message, diagnostics: 'fetch_token' });
      } finally {
        exchangingCode = null;
      }
    };

       const onMaybeUrl = (pageUrl: string) => {
      if (settled) return;
      if (!pageUrl.startsWith('http')) return;
      const isOutlook = pageUrl.includes('outlook.office.com') || pageUrl.includes('outlook.cloud.microsoft');
      const isRedirectMatch = pageUrl.includes(redirect.split('?')[0].replace(/\/$/, ''));
      const isLogin = pageUrl.includes('login.microsoftonline.com');
      if (!isOutlook && !isRedirectMatch && !isLogin) return;
      const code = extractAuthCodeFromUrl(pageUrl);
      if (code) void tryExchangeCode(code);
    };

    win.webContents.on('did-navigate', (_e, url) => onMaybeUrl(url));
    win.webContents.on('did-navigate-in-page', (_e, url) => onMaybeUrl(url));
    win.webContents.on('will-redirect', (_e, url) => onMaybeUrl(url));

    win.loadURL(authUrl).catch(err => {
      clearTimeout(timeout);
      finish({ success: false, error: `Failed to load authorize URL: ${(err as Error).message}` });
    });
  });
}
