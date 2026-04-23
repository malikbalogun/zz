import { ipcRenderer } from 'electron';

console.log('[HighHopes] Preload script loaded for mailbox window');

// ---------------------------------------------------------------------------
// 1. Inject fresh cache from main process (without clearing OWA local state)
// ---------------------------------------------------------------------------

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
// 2. Capture OWA client ID from login URLs (do not block iframe loads)
// ---------------------------------------------------------------------------
(function () {
  let lastSentClientId = '';
  function captureClientId(url: string) {
    try {
      const u = new URL(url);
      const cid = u.searchParams.get('client_id');
      if (cid && cid !== 'd3590ed6-52b3-4102-aeff-aad2292ab01c' && cid !== lastSentClientId) {
        lastSentClientId = cid;
        console.log('[PRELOAD] OWA client ID intercepted:', cid);
        ipcRenderer.send('owa-client-id-found', cid);
      }
    } catch {}
  }

  const isLoginUrl = (s: string) =>
    typeof s === 'string' && (s.includes('login.microsoftonline.com') || s.includes('login.windows.net'));

  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (isLoginUrl(url)) captureClientId(url);
    return originalFetch(input, init);
  }) as typeof window.fetch;

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ) {
    const asString = typeof url === 'string' ? url : url.toString();
    if (isLoginUrl(asString)) captureClientId(asString);
    return originalOpen.call(this, method, url as any, async ?? true, username ?? null, password ?? null);
  };

  const originalCreateElement = document.createElement.bind(document);
  (document.createElement as any) = function (...args: any[]) {
    const el = originalCreateElement(args[0] as any, args[1] as any);
    if (String(args[0] || '').toLowerCase() === 'iframe') {
      const originalSetAttribute = el.setAttribute.bind(el);
      el.setAttribute = function (name: string, value: string) {
        if (name === 'src' && isLoginUrl(value)) captureClientId(value);
        return originalSetAttribute(name, value);
      };
    }
    return el;
  };

  const observer = new MutationObserver(() => {
    const iframes = document.querySelectorAll('iframe[src]');
    for (const iframe of iframes) {
      const src = iframe.getAttribute('src');
      if (src && isLoginUrl(src)) captureClientId(src);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('beforeunload', () => observer.disconnect(), { once: true });

  console.log('[PRELOAD] Client-ID capture installed (non-blocking)');
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

    const candidates = Array.from(
      document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')
    ) as HTMLElement[];
    const signInEl = candidates.find((el) => {
      const txt = (el.innerText || (el as HTMLInputElement).value || '').trim();
      return SIGN_IN_TEXT.test(txt);
    });
    const canAttemptHeuristic =
      location.hostname.includes('outlook.office.com') &&
      (Date.now() - (window.performance?.timeOrigin || Date.now())) < 120_000;
    if (!showsExpiryBanner && !SESSION_EXPIRED_TEXT.test(bodyText) && !canAttemptHeuristic) return;
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
