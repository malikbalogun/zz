/**
 * Shared cookie paste parsing (Netscape export, JSON array, or "a=b; c=d" header).
 * Used by renderer (Add Account) and main (session hydration + token conversion).
 */

export interface ParsedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  /** Unix seconds */
  expirationDate?: number;
  /** When known (e.g. from Electron `session.cookies`), export to extension JSON accurately */
  httpOnly?: boolean;
  /** Electron / Chromium same-site policy, or extension string */
  sameSite?: string;
}

/** Substrings; cookie domain may be `.login.microsoftonline.com` etc. */
export const MICROSOFT_COOKIE_DOMAIN_HINTS: string[] = [
  'login.microsoftonline.com',
  'login.live.com',
  'outlook.office.com',
  'outlook.cloud.microsoft',
  'microsoftonline.com',
  'office.com',
  'microsoft.com',
  'live.com',
];

export function parseCookiePaste(raw: string): ParsedCookie[] {
  const t = raw.trim();
  if (!t) return [];

  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t) as unknown;
      if (!Array.isArray(arr)) return [];
      const out: ParsedCookie[] = [];
      for (const row of arr) {
        if (!row || typeof row !== 'object') continue;
        const o = row as Record<string, unknown>;
        const name = String(o.name ?? o.Name ?? '').trim();
        const value = String(o.value ?? o.Value ?? '').trim();
        if (!name) continue;
        const domainRaw = o.domain ?? o.Domain ?? o.host ?? o.Host;
        const pathRaw = o.path ?? o.Path ?? '/';
        const exp =
          typeof o.expirationDate === 'number'
            ? o.expirationDate
            : typeof (o as { expires?: unknown }).expires === 'number'
              ? ((o as { expires: number }).expires > 1e12 ? Math.floor((o as { expires: number }).expires / 1000)
                  : (o as { expires: number }).expires)
              : undefined;
        const httpRaw = o.httpOnly ?? o.HttpOnly;
        const ssRaw = o.sameSite ?? o.SameSite ?? o.same_site;
        out.push({
          name,
          value,
          domain: domainRaw != null ? String(domainRaw).trim() : undefined,
          path: pathRaw != null ? String(pathRaw).trim() : '/',
          secure: !!(o.secure ?? o.Secure ?? o.httpOnly),
          expirationDate: exp,
          httpOnly: typeof httpRaw === 'boolean' ? httpRaw : undefined,
          sameSite: ssRaw != null ? String(ssRaw) : undefined,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  const lines = t.split(/\r?\n/);
  const looksNetscape =
    lines.some(l => l.trim().startsWith('#')) ||
    lines.filter(l => l.trim() && !l.trim().startsWith('#')).some(l => l.split('\t').length >= 7);

  if (looksNetscape) {
    const out: ParsedCookie[] = [];
    for (const line of lines) {
      const L = line.trim();
      if (!L || L.startsWith('#')) continue;
      const parts = L.split('\t');
      if (parts.length < 7) continue;
      const domain = parts[0]?.trim();
      const path = parts[2]?.trim() || '/';
      const secure = (parts[3]?.trim() || '').toUpperCase() === 'TRUE';
      const expirySec = parseInt(parts[4]?.trim() || '0', 10) || undefined;
      const name = parts[5]?.trim();
      const value = parts.slice(6).join('\t').trim();
      if (!name) continue;
      out.push({
        domain,
        path,
        secure,
        expirationDate: expirySec && expirySec > 0 ? expirySec : undefined,
        name,
        value,
      });
    }
    if (out.length) return out;
  }

  if (t.includes('=')) {
    const out: ParsedCookie[] = [];
    for (const p of t.split(';').map(x => x.trim()).filter(Boolean)) {
      const eq = p.indexOf('=');
      if (eq <= 0) continue;
      const name = p.slice(0, eq).trim();
      const value = p.slice(eq + 1).trim();
      if (name) out.push({ name, value });
    }
    return out;
  }

  return [];
}

export function cookiesToHeaderString(cookies: ParsedCookie[]): string {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

export function normalizeCookiePasteToHeaderString(raw: string): string {
  const parsed = parseCookiePaste(raw);
  if (!parsed.length) return raw.trim();
  return cookiesToHeaderString(parsed);
}

function domainMatchesHint(domainLower: string, hint: string): boolean {
  const h = hint.replace(/^\./, '');
  return domainLower === h || domainLower.endsWith('.' + h);
}

/** Keep cookies that look Microsoft-related, or header-only cookies (no domain). */
export function filterMicrosoftRelatedCookies(cookies: ParsedCookie[]): ParsedCookie[] {
  return cookies.filter(c => {
    const d = (c.domain || '').toLowerCase();
    if (!d) return true;
    return MICROSOFT_COOKIE_DOMAIN_HINTS.some(h => domainMatchesHint(d, h));
  });
}

/**
 * Serialise cookies back to **Netscape HTTP Cookie File** format. This is the
 * round-trip format that `parseCookiePaste` already reads via the `looksNetscape`
 * branch, so an exported file can be re-imported through the existing Add
 * Account → Cookie tab without any extra logic.
 *
 * Output line format (tab-separated):
 *   domain  includeSubdomains  path  secure  expiry  name  value
 */
export function cookiesToNetscape(cookies: ParsedCookie[]): string {
  const lines: string[] = [
    '# Netscape HTTP Cookie File',
    '# https://curl.se/docs/http-cookies.html',
    '# This file was generated by Watcher.',
    '',
  ];
  for (const c of cookies) {
    if (!c.name) continue;
    const rawDomain = (c.domain || '').trim();
    if (!rawDomain) continue; // Netscape format requires a domain
    const includeSubdomains = rawDomain.startsWith('.') ? 'TRUE' : 'FALSE';
    const path = c.path && c.path.startsWith('/') ? c.path : '/';
    const secure = c.secure === false ? 'FALSE' : 'TRUE';
    const expiry = c.expirationDate && c.expirationDate > 0 ? Math.floor(c.expirationDate) : 0;
    lines.push(
      [rawDomain, includeSubdomains, path, secure, String(expiry), c.name, c.value].join('\t')
    );
  }
  return lines.join('\n') + '\n';
}

/** Base URL for Electron session.cookies.set */
export function cookieToSetUrl(c: ParsedCookie): string {
  let host = (c.domain || '').replace(/^\./, '').trim();
  if (!host) return 'https://outlook.office.com/';
  const proto = c.secure === false ? 'http' : 'https';
  return `${proto}://${host}/`;
}

/**
 * Session cookie names that indicate a real Microsoft sign-in (not only helper
 * cookies). Used for OWA export quality and cookie-capture completion detection.
 */
export const STRONG_MICROSOFT_AUTH_COOKIE_PATTERNS: RegExp[] = [
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

export function hasStrongMicrosoftSessionCookies(cookies: ParsedCookie[]): boolean {
  return cookies.some((c) => {
    const name = String(c.name || '').trim();
    if (!name) return false;
    return STRONG_MICROSOFT_AUTH_COOKIE_PATTERNS.some((re) => re.test(name));
  });
}

export function countStrongMicrosoftSessionCookies(cookies: ParsedCookie[]): number {
  let n = 0;
  for (const c of cookies) {
    const name = String(c.name || '').trim();
    if (!name) continue;
    if (STRONG_MICROSOFT_AUTH_COOKIE_PATTERNS.some((re) => re.test(name))) n++;
  }
  return n;
}

function cookieOriginForUrl(c: ParsedCookie): string {
  const host = (c.domain || '').replace(/^\./, '').trim() || 'outlook.office.com';
  const proto = c.secure === false ? 'http' : 'https';
  return `${proto}://${host}`;
}

/**
 * JSON array compatible with browser extensions such as "EditThisCookie"
 * (domain, name, value, path, secure, expirationDate, httpOnly, sameSite, url, …).
 */
export function cookiesToEditThisCookieJson(cookies: ParsedCookie[]): string {
  const rows = cookies.map((c) => {
    const domain = (c.domain || '').trim() || '.login.microsoftonline.com';
    const hostOnly = !domain.startsWith('.');
    const exp = c.expirationDate && c.expirationDate > 0 ? c.expirationDate : undefined;
    const path = c.path && c.path.startsWith('/') ? c.path : '/';
    const origin = cookieOriginForUrl(c);
    const pathForUrl = path.startsWith('/') ? path : `/${path}`;
    const url = `${origin}${pathForUrl === '//' ? '/' : pathForUrl}`;
    const httpOnly =
      typeof c.httpOnly === 'boolean' ? c.httpOnly : /ESTS|SID|session|Auth|token|nonce|esctx|FedAuth|RPSAuth|MSP/i.test(c.name);
    const sameSite =
      c.sameSite && String(c.sameSite).trim()
        ? String(c.sameSite)
        : 'unspecified';
    return {
      domain,
      expirationDate: exp,
      hostOnly,
      httpOnly,
      name: c.name,
      path,
      sameSite,
      secure: c.secure !== false,
      session: !exp,
      storeId: '0',
      url,
      value: c.value,
    };
  });
  return JSON.stringify(rows, null, 2) + '\n';
}
