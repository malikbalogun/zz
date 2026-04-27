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
  /** Browser/export string ('none' | 'lax' | 'strict') or Electron value ('no_restriction'). */
  sameSite?: string;
  hostOnly?: boolean;
  session?: boolean;
  storeId?: string | null;
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
        const sameSiteRaw = o.sameSite ?? o.SameSite;
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
          secure: !!(o.secure ?? o.Secure),
          httpOnly: !!(o.httpOnly ?? o.HttpOnly),
          sameSite: sameSiteRaw != null ? String(sameSiteRaw).trim().toLowerCase() : undefined,
          hostOnly: typeof o.hostOnly === 'boolean' ? o.hostOnly : undefined,
          session: typeof o.session === 'boolean' ? o.session : undefined,
          storeId:
            typeof o.storeId === 'string' || o.storeId === null
              ? (o.storeId as string | null)
              : undefined,
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
        hostOnly: domain ? !domain.startsWith('.') : undefined,
        session: !(expirySec && expirySec > 0),
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

/**
 * Serialise cookies to a JSON array compatible with browser cookie editors
 * (for example "EditThisCookie"), so users can import the session directly.
 */
export function cookiesToCookieEditorJson(cookies: ParsedCookie[]): string {
  const rows = cookies
    .filter((c) => !!c.name)
    .map((c) => {
      const rawDomain = (c.domain || '').trim();
      const session = c.session === true || !(c.expirationDate && c.expirationDate > 0);
      const sameSiteRaw = String(c.sameSite || '').toLowerCase();
      const sameSite =
        sameSiteRaw === 'none'
          ? 'no_restriction'
          : sameSiteRaw === 'no_restriction' || sameSiteRaw === 'lax' || sameSiteRaw === 'strict'
            ? sameSiteRaw
            : 'unspecified';
      return {
        name: c.name,
        value: c.value ?? '',
        domain: rawDomain,
        path: c.path && c.path.startsWith('/') ? c.path : '/',
        secure: c.secure !== false,
        httpOnly: c.httpOnly === true,
        hostOnly: typeof c.hostOnly === 'boolean' ? c.hostOnly : rawDomain ? !rawDomain.startsWith('.') : false,
        session,
        sameSite,
        expirationDate: session ? undefined : Math.floor(c.expirationDate as number),
        storeId: c.storeId ?? '0',
      };
    });
  return JSON.stringify(rows, null, 2);
}

/**
 * Pick the best browser URL where the exported cookies should be installed.
 * Outlook inbox is preferred because it directly validates mailbox session.
 */
export function pickPrimaryCookieOrigin(cookies: ParsedCookie[]): string {
  const hosts = new Set(
    cookies
      .map((c) => (c.domain || '').toLowerCase().replace(/^\./, '').trim())
      .filter(Boolean)
  );
  if ([...hosts].some((h) => h.endsWith('outlook.office.com') || h.endsWith('outlook.office365.com'))) {
    return 'https://outlook.office.com/mail/inbox';
  }
  if ([...hosts].some((h) => h.endsWith('outlook.cloud.microsoft'))) {
    return 'https://outlook.cloud.microsoft/mail/inbox';
  }
  if ([...hosts].some((h) => h.endsWith('office.com'))) {
    return 'https://office.com/';
  }
  if ([...hosts].some((h) => h.endsWith('login.microsoftonline.com'))) {
    return 'https://login.microsoftonline.com/';
  }
  return 'https://outlook.office.com/mail/inbox';
}

/**
 * Build a paste-ready DevTools console snippet that installs as many cookies as
 * the browser allows from page JavaScript, then optionally reloads the tab.
 *
 * Note: HttpOnly cookies cannot be set via `document.cookie`, so for full
 * fidelity users should prefer Cookie-Editor/EditThisCookie JSON import.
 */
export function cookiesToBrowserConsoleSnippet(
  cookies: ParsedCookie[],
  opts: { email?: string; reload?: boolean } = {}
): string {
  const settable: ParsedCookie[] = [];
  const skippedHttpOnly: string[] = [];
  for (const c of cookies) {
    if (!c.name) continue;
    if (c.httpOnly) {
      skippedHttpOnly.push(c.name);
      continue;
    }
    if (!(c.domain || '').trim()) continue;
    settable.push(c);
  }

  const reload = opts.reload !== false;
  const emailComment = opts.email ? ` for ${opts.email}` : '';
  const httpOnlyComment = skippedHttpOnly.length
    ? `// NOTE: ${skippedHttpOnly.length} HttpOnly cookies cannot be installed from\n` +
      '//       this snippet (browsers block document.cookie writes for them).\n' +
      '//       Use the Cookie-Editor / EditThisCookie extension with JSON\n' +
      `//       import for full session: ${skippedHttpOnly.slice(0, 8).join(', ')}` +
      (skippedHttpOnly.length > 8 ? ', ...' : '') +
      '\n'
    : '';

  const payload = settable.map((c) => {
    const domainAttr =
      (c.domain || '').startsWith('.') ? c.domain : '.' + (c.domain || '').replace(/^\./, '');
    return {
      n: c.name,
      v: c.value,
      d: domainAttr,
      p: c.path && c.path.startsWith('/') ? c.path : '/',
      s: c.secure !== false,
      e: c.expirationDate && c.expirationDate > 0 ? Math.floor(c.expirationDate) : 0,
    };
  });

  const lines: string[] = [];
  lines.push('// Watcher browser cookie installer' + emailComment);
  lines.push('// Paste in DevTools console on an Outlook/Office tab, press Enter, then reload.');
  lines.push('// If login is still incomplete, use Cookie-Editor/EditThisCookie JSON import.');
  if (httpOnlyComment) lines.push(httpOnlyComment.trimEnd());
  lines.push('(function () {');
  lines.push('  var cookies = ' + JSON.stringify(payload) + ';');
  lines.push('  var installed = 0, skipped = 0;');
  lines.push('  var pageHost = location.hostname.toLowerCase();');
  lines.push('  function regDom(h){ h = (h||"").replace(/^\\./, "").toLowerCase(); if(!h) return ""; var p = h.split("."); return p.slice(-2).join("."); }');
  lines.push('  var pageReg = regDom(pageHost);');
  lines.push('  for (var i = 0; i < cookies.length; i++) {');
  lines.push('    var c = cookies[i];');
  lines.push('    var cookieReg = regDom(c.d);');
  lines.push('    if (cookieReg && pageReg && cookieReg !== pageReg) { skipped++; continue; }');
  lines.push('    var parts = [c.n + "=" + c.v, "path=" + (c.p || "/")];');
  lines.push('    if (c.d) parts.push("domain=" + c.d);');
  lines.push('    if (c.s) parts.push("secure");');
  lines.push('    parts.push("samesite=None");');
  lines.push('    if (c.e) parts.push("expires=" + new Date(c.e * 1000).toUTCString());');
  lines.push('    try { document.cookie = parts.join("; "); installed++; } catch (e) { skipped++; }');
  lines.push('  }');
  lines.push('  console.log("[Watcher] Installed " + installed + " cookies, skipped " + skipped + ".");');
  if (reload) {
    lines.push('  setTimeout(function () { location.reload(); }, 250);');
  }
  lines.push('})();');
  return lines.join('\n') + '\n';
}

/** Base URL for Electron session.cookies.set */
export function cookieToSetUrl(c: ParsedCookie): string {
  let host = (c.domain || '').replace(/^\./, '').trim();
  if (!host) return 'https://outlook.office.com/';
  const proto = c.secure === false ? 'http' : 'https';
  return `${proto}://${host}/`;
}
