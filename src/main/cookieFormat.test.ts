import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCookiePaste,
  normalizeCookiePasteToHeaderString,
  filterMicrosoftRelatedCookies,
  cookieToSetUrl,
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
