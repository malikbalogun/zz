/**
 * Minimal preload for OWA windows that rely on Microsoft session cookies only
 * (no MSAL cache injection — avoids clearing OWA localStorage keys used by the SPA).
 */
console.log('[MailboxCookie] Preload loaded (cookie-session OWA)');

// Auto-heal transient "session expired / Sign in" banners in cookie mode.
// Keep this lightweight and DOM-only (no Node/Electron APIs needed).
(function () {
  const SIGN_IN_TEXT = /sign\s*in/i;
  const SESSION_EXPIRED_TEXT = /session has expired|you need to sign in/i;
  let autoClicked = 0;
  const maxAutoClicks = 6;

  function tryAutoClickSignIn(): void {
    if (autoClicked >= maxAutoClicks) return;
    const bodyText = (document.body?.innerText || '').toLowerCase();
    if (!SESSION_EXPIRED_TEXT.test(bodyText)) return;

    const candidates = Array.from(
      document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')
    ) as HTMLElement[];
    const signInEl = candidates.find((el) => {
      const txt = (el.innerText || (el as HTMLInputElement).value || '').trim();
      return SIGN_IN_TEXT.test(txt);
    });
    if (!signInEl) return;

    autoClicked++;
    console.log(`[MailboxCookie] Auto-clicking sign-in ${autoClicked}/${maxAutoClicks}`);
    try {
      signInEl.click();
    } catch {
      // ignore click errors
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
