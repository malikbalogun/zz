import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCookiePaste,
  normalizeCookiePasteToHeaderString,
  filterMicrosoftRelatedCookies,
  cookieToSetUrl,
  cookiesToNetscape,
  cookiesToCookieEditorJson,
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

test('cookiesToNetscape skips entries with no domain', () => {
  const text = cookiesToNetscape([
    { name: 'orphan', value: 'v' }, // no domain — Netscape requires one
    { name: 'ok', value: 'v', domain: 'outlook.office.com' },
  ]);
  const dataLines = text.split('\n').filter(l => l && !l.startsWith('#'));
  assert.equal(dataLines.length, 1);
  assert.ok(dataLines[0].endsWith('\tok\tv'));
});

test('cookiesToCookieEditorJson emits extension-friendly fields', () => {
  const json = cookiesToCookieEditorJson([
    {
      name: 'ESTSAUTH',
      value: 'abc123',
      domain: '.login.microsoftonline.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction',
      expirationDate: 1893456000,
    },
  ]);
  const rows = JSON.parse(json);
  assert.equal(Array.isArray(rows), true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'ESTSAUTH');
  assert.equal(rows[0].httpOnly, true);
  assert.equal(rows[0].sameSite, 'no_restriction');
  assert.equal(rows[0].secure, true);
  assert.equal(rows[0].storeId, '0');
});
