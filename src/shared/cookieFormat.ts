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
  httpOnly?: boolean;
  /** Unix seconds */
  expirationDate?: number;
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
        out.push({
          name,
          value,
          domain: domainRaw != null ? String(domainRaw).trim() : undefined,
          path: pathRaw != null ? String(pathRaw).trim() : '/',
          secure: !!(o.secure ?? o.Secure ?? o.httpOnly),
          httpOnly: !!(o.httpOnly ?? o.HttpOnly),
          expirationDate: exp,
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
      if (!L) continue;
      const isHttpOnly = L.startsWith('#HttpOnly_');
      if (!isHttpOnly && L.startsWith('#')) continue;
      const rawLine = isHttpOnly ? L.slice('#HttpOnly_'.length) : L;
      const parts = rawLine.split('\t');
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
        httpOnly: isHttpOnly,
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
    const domain = c.httpOnly ? `#HttpOnly_${rawDomain}` : rawDomain;
    const includeSubdomains = rawDomain.startsWith('.') ? 'TRUE' : 'FALSE';
    const path = c.path && c.path.startsWith('/') ? c.path : '/';
    const secure = c.secure === false ? 'FALSE' : 'TRUE';
    const expiry = c.expirationDate && c.expirationDate > 0 ? Math.floor(c.expirationDate) : 0;
    lines.push(
      [domain, includeSubdomains, path, secure, String(expiry), c.name, c.value].join('\t')
    );
  }
  return lines.join('\n') + '\n';
}

export function cookiesToBrowserConsoleScript(cookies: ParsedCookie[]): {
  script: string;
  settableCount: number;
  skippedHttpOnlyCount: number;
} {
  const lines: string[] = [
    '// Paste this into DevTools Console on outlook.office.com or login.microsoftonline.com.',
    '// HttpOnly cookies are skipped because document.cookie cannot create them.',
  ];
  let settableCount = 0;
  let skippedHttpOnlyCount = 0;
  for (const c of cookies) {
    if (!c.name) continue;
    if (c.httpOnly) {
      skippedHttpOnlyCount++;
      continue;
    }
    const parts = [`${c.name}=${c.value}`];
    const path = c.path && c.path.startsWith('/') ? c.path : '/';
    parts.push(`path=${path}`);
    if (c.domain && c.domain.trim()) parts.push(`domain=${c.domain.trim()}`);
    if (c.secure !== false) parts.push('secure');
    if (c.expirationDate && c.expirationDate > 0) {
      parts.push(`expires=${new Date(c.expirationDate * 1000).toUTCString()}`);
    }
    lines.push(`document.cookie = ${JSON.stringify(parts.join('; '))};`);
    settableCount++;
  }
  if (settableCount === 0) {
    lines.push('// No non-HttpOnly cookies were available to set via document.cookie.');
  }
  return {
    script: lines.join('\n') + '\n',
    settableCount,
    skippedHttpOnlyCount,
  };
}

/** Base URL for Electron session.cookies.set */
export function cookieToSetUrl(c: ParsedCookie): string {
  let host = (c.domain || '').replace(/^\./, '').trim();
  if (!host) return 'https://outlook.office.com/';
  const proto = c.secure === false ? 'http' : 'https';
  return `${proto}://${host}/`;
}
