/**
 * Minimal preload for OWA windows that rely on Microsoft session cookies only
 * (no MSAL cache injection — avoids clearing OWA localStorage keys used by the SPA).
 */
console.log('[MailboxCookie] Preload loaded (cookie-session OWA)');
