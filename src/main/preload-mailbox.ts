import { ipcRenderer } from 'electron';

console.log('[HighHopes] Preload script loaded for mailbox window');

// ---------------------------------------------------------------------------
// 1. Inject MSAL cache from main process
// ---------------------------------------------------------------------------
// IMPORTANT:
// Do NOT clear existing MSAL/browser auth keys here. OWA may actively manage
// first-party session keys during sign-in/renewal, and aggressive clearing can
// cause endless "session expired" loops after reload.

try {
  console.log('[HighHopes] Requesting MSAL cache from main process...');
  const entries = ipcRenderer.sendSync('get-msal-cache');
  console.log('[HighHopes] Received entries:', entries ? Object.keys(entries).length : 0, 'keys');
  if (entries && typeof entries === 'object') {
    const keys = Object.keys(entries);
    for (const k of keys) localStorage.setItem(k, entries[k]);
    console.log(`[HighHopes] MSAL cache injected: ${keys.length} entries`);
  } else {
    console.warn('[HighHopes] No MSAL cache entries received');
  }
} catch (err) {
  console.error('[HighHopes] Cache injection error:', (err as any).message);
}

// ---------------------------------------------------------------------------
// 2. Capture OWA client ID from login iframe URLs (without blocking auth)
// ---------------------------------------------------------------------------
(function () {
  function captureClientId(url: string) {
    try {
      const u = new URL(url);
      const cid = u.searchParams.get('client_id');
      if (cid && cid !== 'd3590ed6-52b3-4102-aeff-aad2292ab01c') {
        console.log('[PRELOAD] OWA client ID intercepted:', cid);
        ipcRenderer.send('owa-client-id-found', cid);
      }
    } catch {}
  }

  const originalCreateElement = document.createElement.bind(document);
  (document.createElement as any) = function (tag: string) {
    const el = originalCreateElement(tag);
    if (tag.toLowerCase() === 'iframe') {
      const isLoginUrl = (s: string) =>
        typeof s === 'string' && (s.includes('login.microsoftonline.com') || s.includes('login.windows.net'));
      const origSetAttribute = el.setAttribute.bind(el);
      el.setAttribute = function (n: string, v: string) {
        if (n === 'src' && isLoginUrl(v)) captureClientId(v);
        return origSetAttribute(n, v);
      };
    }
    return el;
  };

  // Also observe direct iframe.src assignments on already-created iframes.
  // We only capture metadata; we do NOT block navigation.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type !== 'attributes' || record.attributeName !== 'src') continue;
      const target = record.target as HTMLIFrameElement;
      if (target && target.tagName === 'IFRAME' && typeof target.src === 'string') {
        captureClientId(target.src);
      }
    }
  });
  observer.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['src'] });

  console.log('[PRELOAD] Iframe client-ID capture installed (auth iframes allowed)');
})();

// ---------------------------------------------------------------------------
// 3. Auto-heal transient OWA "session expired / Sign in" banners
// ---------------------------------------------------------------------------
(function () {
  const SIGN_IN_TEXT = /sign\s*in/i;
  const SESSION_EXPIRED_TEXT = /session has expired|you need to sign in/i;
  let autoClicked = 0;
  const maxAutoClicks = 6;

  function tryAutoClickSignIn(): void {
    if (autoClicked >= maxAutoClicks) return;
    const bodyText = (document.body?.innerText || '').toLowerCase();
    const showsExpiryBanner =
      bodyText.includes('session has expired') || bodyText.includes('you need to sign in');
    if (!showsExpiryBanner && !SESSION_EXPIRED_TEXT.test(bodyText)) return;

    const candidates = Array.from(
      document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')
    ) as HTMLElement[];
    const signInEl = candidates.find((el) => {
      const txt = (el.innerText || (el as HTMLInputElement).value || '').trim();
      return SIGN_IN_TEXT.test(txt);
    });
    if (!signInEl) return;

    autoClicked++;
    console.log(`[OWA AutoSignIn] Clicking sign-in button attempt ${autoClicked}/${maxAutoClicks}`);
    try {
      signInEl.click();
    } catch (err: any) {
      console.warn('[OWA AutoSignIn] click failed:', err?.message || err);
    }
  }

  const interval = window.setInterval(tryAutoClickSignIn, 2500);
  window.setTimeout(() => window.clearInterval(interval), 120_000);

  const observer = new MutationObserver(() => {
    tryAutoClickSignIn();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('beforeunload', () => observer.disconnect(), { once: true });
})();

console.log('[HighHopes] Preload complete');
