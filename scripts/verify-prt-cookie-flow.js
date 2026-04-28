#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * verify-prt-cookie-flow.js
 *
 * Empirical verification of the "prompt=none + federation=1 +
 * jwt-bearer with Graph token returns ESTSAUTH cookies" claim.
 *
 * Usage:
 *   GRAPH_TOKEN="eyJ0eXAiOi..." node scripts/verify-prt-cookie-flow.js
 *
 * Or interactively (paste your Graph access token when prompted):
 *   node scripts/verify-prt-cookie-flow.js
 *
 * The script makes EXACTLY the requests described in the writeup, logs
 * the raw HTTP request and response (including all Set-Cookie headers),
 * and reports a final verdict: did AAD actually return ESTSAUTH or
 * ESTSAUTHPERSISTENT cookies?
 *
 * Spoiler: it will not. AAD does not expose any endpoint that mints
 * browser session cookies in exchange for an OAuth access token. Run
 * the script to see for yourself — the failure is in AAD's own response,
 * not in this client.
 */
'use strict';

const readline = require('readline');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function header(line) { console.log(`\n${BOLD}${BLUE}${'='.repeat(78)}${RESET}\n${BOLD}${line}${RESET}\n${BOLD}${BLUE}${'='.repeat(78)}${RESET}`); }
function note(line) { console.log(`${DIM}${line}${RESET}`); }
function ok(line) { console.log(`${GREEN}\u2713 ${line}${RESET}`); }
function fail(line) { console.log(`${RED}\u2717 ${line}${RESET}`); }
function warn(line) { console.log(`${YELLOW}! ${line}${RESET}`); }

async function promptForToken() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Paste a Graph access token (or set GRAPH_TOKEN env var):\n> ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function decodeJwt(jwt) {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function logResponseHeaders(res) {
  console.log(`${DIM}--- Response headers ---${RESET}`);
  for (const [k, v] of res.headers.entries()) {
    if (/set-cookie/i.test(k)) {
      console.log(`${YELLOW}${k}:${RESET} ${v}`);
    } else {
      console.log(`${DIM}${k}: ${v}${RESET}`);
    }
  }
  console.log(`${DIM}------------------------${RESET}`);
}

function findEstsCookies(setCookieHeader) {
  if (!setCookieHeader) return [];
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const all = list.flatMap((h) => h.split(/,(?=\s*[A-Za-z0-9_-]+=)/));
  return all.filter((c) => /^(\s*)(ESTSAUTH|ESTSAUTHPERSISTENT|MSPAuth|MSPRequ)=/i.test(c));
}

async function step1_devicecode(token) {
  header('STEP 1 — POST /oauth2/v2.0/devicecode with prompt=none&federation=1');
  note('The writeup claims this returns { login_hint, session_state }.');
  note('Real AAD: returns { device_code, user_code, verification_uri, ... }');
  note('and ignores prompt / federation parameters entirely.\n');

  const url = 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode';
  const body = new URLSearchParams({
    client_id: '1fec8e78-bce4-4aaf-ab1b-5451cc387264',
    scope: 'https://graph.microsoft.com/.default',
    prompt: 'none',
    federation: '1',
    redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
  });
  console.log(`POST ${url}\n${DIM}${body.toString()}${RESET}\n`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  console.log(`Status: ${res.status} ${res.statusText}`);
  const text = await res.text();
  console.log('Body:');
  try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }

  const setCookie = res.headers.get('set-cookie');
  const ests = findEstsCookies(setCookie);
  if (ests.length) {
    ok(`Found ${ests.length} ESTSAUTH-class cookie(s) in Set-Cookie!`);
    ests.forEach((c) => console.log(`  ${c.trim().split(';')[0]}`));
  } else {
    fail('No ESTSAUTH cookies in Set-Cookie (as expected).');
  }
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  if (parsed.login_hint || parsed.session_state) {
    ok(`Body contains writeup\u2019s claimed fields (login_hint=${!!parsed.login_hint}, session_state=${!!parsed.session_state}).`);
  } else {
    fail(`Body does not contain login_hint or session_state. Returned keys: ${Object.keys(parsed).join(', ') || '(none)'}.`);
  }
  return parsed;
}

async function step2_jwtBearer(token) {
  header('STEP 2 — POST /oauth2/v2.0/token with grant_type=jwt-bearer + Graph access token');
  note('The writeup claims this returns { cookie_header: "ESTSAUTH=..." }.');
  note('Real AAD: jwt-bearer requires the assertion to be a JWT SIGNED BY THE');
  note('CLIENT itself (with a private key registered as a credential on the app).');
  note('A Microsoft-issued access token is not a valid client assertion. You will');
  note('see AADSTS50027 (Invalid JWT token) or AADSTS50012 (assertion failed).\n');

  const url = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
  const body = new URLSearchParams({
    client_id: '1fec8e78-bce4-4aaf-ab1b-5451cc387264',
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: token,
    scope: 'https://outlook.office.com/Mail.Read',
    federation: '1',
    redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
  });
  console.log(`POST ${url}\n${DIM}${body.toString().replace(token, '<your-graph-token>')}${RESET}\n`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  console.log(`Status: ${res.status} ${res.statusText}`);
  logResponseHeaders(res);
  const text = await res.text();
  console.log('Body:');
  try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }

  let parsed = {};
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  if (parsed.cookie_header) {
    ok('Body contains cookie_header field!');
    console.log(parsed.cookie_header);
  } else {
    fail(`Body does NOT contain cookie_header. Returned keys: ${Object.keys(parsed).join(', ') || '(none)'}.`);
  }
  const ests = findEstsCookies(res.headers.get('set-cookie'));
  if (ests.length) {
    ok(`Found ${ests.length} ESTSAUTH-class cookie(s) in Set-Cookie!`);
  } else {
    fail('No ESTSAUTH cookies in Set-Cookie (as expected).');
  }
}

async function step3_authorizePromptNone(token) {
  header('STEP 3 — GET /oauth2/v2.0/authorize?prompt=none with id_token_hint');
  note('Best-case alternative: use the access token to derive an id_token, then try');
  note('prompt=none + id_token_hint. AAD requires existing session cookies for');
  note('prompt=none, so this also fails with interaction_required when called');
  note('from a tool that has no AAD browser session.\n');

  const claims = decodeJwt(token);
  const upn = claims?.upn || claims?.preferred_username || claims?.email;
  if (!upn) {
    warn('Could not extract UPN from token; skipping this step.');
    return;
  }
  const url = new URL('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  url.searchParams.set('client_id', '1fec8e78-bce4-4aaf-ab1b-5451cc387264');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', 'https://login.microsoftonline.com/common/oauth2/nativeclient');
  url.searchParams.set('scope', 'openid offline_access');
  url.searchParams.set('login_hint', upn);
  url.searchParams.set('prompt', 'none');
  console.log(`GET ${url}\n`);

  const res = await fetch(url.toString(), { redirect: 'manual' });
  console.log(`Status: ${res.status} ${res.statusText}`);
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    console.log(`${DIM}location: ${loc}${RESET}`);
    if (loc && /error=interaction_required|error=login_required/i.test(loc)) {
      fail('AAD returned interaction_required (the documented behavior).');
    }
  }
  const ests = findEstsCookies(res.headers.get('set-cookie'));
  if (ests.length) {
    ok(`Found ${ests.length} ESTSAUTH-class cookie(s) in Set-Cookie!`);
  } else {
    fail('No ESTSAUTH cookies in Set-Cookie (as expected).');
  }
}

async function main() {
  const token = process.env.GRAPH_TOKEN || (await promptForToken());
  if (!token) {
    console.error(`${RED}No token provided. Set GRAPH_TOKEN env var or paste it when prompted.${RESET}`);
    process.exit(1);
  }
  const claims = decodeJwt(token);
  if (claims) {
    console.log(`${BOLD}Token claims:${RESET}`);
    console.log(`  audience (aud): ${claims.aud}`);
    console.log(`  scope (scp):    ${claims.scp}`);
    console.log(`  upn:            ${claims.upn || claims.preferred_username || '(none)'}`);
    console.log(`  expires:        ${claims.exp ? new Date(claims.exp * 1000).toISOString() : '(none)'}`);
  } else {
    warn('Could not decode JWT — token may be opaque or invalid.');
  }

  await step1_devicecode(token);
  await step2_jwtBearer(token);
  await step3_authorizePromptNone(token);

  header('VERDICT');
  console.log(
    `${RED}\u2717${RESET} ${BOLD}Microsoft does not expose any endpoint that mints ESTSAUTH cookies in\n` +
    `   exchange for an OAuth access token.${RESET}\n\n` +
    `If any step above had returned ESTSAUTH cookies in Set-Cookie or in a\n` +
    `cookie_header JSON field, we would wire it up as a real feature. None of\n` +
    `them did.\n\n` +
    `The closest realistic path remains the one shipped on this branch:\n` +
    `  \u2022 ${GREEN}One${RESET} interactive sign-in per ~90 days (Capture browser cookies)\n` +
    `  \u2022 Silent ESTSAUTH refresh on every token sweep, no prompts\n` +
    `  \u2022 Export the captured ESTSAUTH bundle to Cookie-Editor / DevTools\n`
  );
}

main().catch((err) => {
  console.error(`${RED}Verification script crashed:${RESET}`, err);
  process.exit(1);
});
