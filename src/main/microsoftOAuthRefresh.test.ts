import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAuthorityTenant } from './microsoftOAuthRefresh';

test('normalizeAuthorityTenant: passthrough tenant GUID', () => {
  const tid = 'cf404960-c50f-46d2-8bf3-a3c957283b86';
  assert.equal(normalizeAuthorityTenant(tid), tid);
});

test('normalizeAuthorityTenant: extract tenant from login URL', () => {
  assert.equal(
    normalizeAuthorityTenant('https://login.microsoftonline.com/cf404960-c50f-46d2-8bf3-a3c957283b86/oauth2/v2.0/token'),
    'cf404960-c50f-46d2-8bf3-a3c957283b86'
  );
});

test('normalizeAuthorityTenant: common', () => {
  assert.equal(normalizeAuthorityTenant('common'), 'common');
});
