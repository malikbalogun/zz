import React, { useEffect, useState } from 'react';

interface BrowserCookiesSnippetModalProps {
  accountId: string;
  email: string;
  onCancel: () => void;
}

type PrtSnapshot = {
  email: string;
  cookie: string;
  mintedAt: string;
  expiresAt: string;
  deviceId: string;
  tenantId: string;
};

/** Build the exact `document.cookie="x-ms-RefreshTokenCredential=…"` snippet
 *  that matches the user's reference screenshot. Sets the PRT cookie on
 *  `.login.microsoftonline.com` then navigates to /authorize?prompt=none —
 *  AAD recognizes the PRT, mints fresh ESTSAUTH cookies for the browser
 *  session, and redirects to the inbox. */
function buildPrtSnippet(cookie: string, email: string): string {
  // 30 days is the conservative server-honoured upper bound; AAD will
  // ignore the cookie sooner if the underlying session key is rotated.
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toUTCString();
  const finalUrl =
    'https://login.microsoftonline.com/common/oauth2/v2.0/authorize' +
    '?client_id=d3590ed6-52b3-4102-aeff-aad2292ab01c' +
    '&response_type=code' +
    `&redirect_uri=${encodeURIComponent('https://outlook.office.com/mail/')}` +
    '&response_mode=query' +
    `&scope=${encodeURIComponent('openid profile offline_access https://outlook.office.com/.default')}` +
    `&login_hint=${encodeURIComponent(email)}` +
    '&prompt=none';
  return (
    `document.cookie="x-ms-RefreshTokenCredential=${cookie}; ` +
    `domain=.login.microsoftonline.com; path=/; secure; SameSite=None; ` +
    `expires=${expires}"; ` +
    `location.href=${JSON.stringify(finalUrl)}`
  );
}

const DEFAULT_OFFICE_CLIENT_ID = 'd3590ed6-52b3-4102-aeff-aad2292ab01c';

function decodeJwtPayload(idToken: string): Record<string, unknown> | null {
  try {
    const part = idToken.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

const BrowserCookiesSnippetModal: React.FC<BrowserCookiesSnippetModalProps> = ({
  accountId,
  email,
  onCancel,
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<PrtSnapshot | null>(null);
  const [snippet, setSnippet] = useState<string>('');
  const [copied, setCopied] = useState(false);
  // Inline device-code re-auth state (used when AAD rejects the existing
  // RT as non-FOCI). The whole flow runs without leaving this modal.
  const [reauthState, setReauthState] = useState<
    | { phase: 'idle' }
    | { phase: 'starting' }
    | { phase: 'awaiting'; userCode: string; verificationUri: string; deviceCode: string; interval: number; expiresIn: number }
    | { phase: 'completing' }
    | { phase: 'minting' }
    | { phase: 'failed'; message: string }
  >({ phase: 'idle' });

  const mint = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await window.electron.accounts.mintPrtCookie(accountId);
      if (!r.success) throw new Error(r.error || 'PRT mint failed');
      const snap: PrtSnapshot = {
        email: r.email,
        cookie: r.cookie,
        mintedAt: r.mintedAt,
        expiresAt: r.expiresAt,
        deviceId: r.deviceId,
        tenantId: r.tenantId,
      };
      setSnapshot(snap);
      setSnippet(buildPrtSnippet(snap.cookie, snap.email));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void mint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const handleClearAndRetry = async () => {
    try {
      await window.electron.accounts.clearPrtRegistration(accountId);
    } catch {
      /* ignore */
    }
    await mint();
  };

  /** Inline device-code re-auth: kicks off the device-code flow, polls
   *  until completion, swaps the new (FOCI-eligible) refresh token onto
   *  the existing account row, then re-runs PRT mint. The user never
   *  leaves this modal. */
  const handleInlineDeviceCode = async () => {
    setReauthState({ phase: 'starting' });
    setError(null);
    try {
      const dc = await window.electron.microsoft.startDeviceCode();
      if (!dc?.success) throw new Error(dc?.error || 'Could not start device code');
      const deviceCode: string = dc.deviceCode || dc.device_code;
      const userCode: string = dc.userCode || dc.user_code;
      const verificationUri: string = dc.verification_uri || dc.verificationUri;
      const interval: number = dc.interval || 5;
      const expiresIn: number = dc.expires_in || dc.expiresIn || 900;
      if (!deviceCode || !userCode || !verificationUri) {
        throw new Error('Device-code response missing required fields');
      }
      setReauthState({ phase: 'awaiting', deviceCode, userCode, verificationUri, interval, expiresIn });

      // Open the verification URL in the user's default browser so they
      // can sign in immediately.
      try { await window.electron.browser.open(verificationUri); } catch { /* ignore */ }

      // Poll until the user completes / times out.
      const deadline = Date.now() + expiresIn * 1000;
      let polled: any = null;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, interval * 1000));
        polled = await window.electron.microsoft.pollDeviceCode(deviceCode, DEFAULT_OFFICE_CLIENT_ID, 'common');
        if (polled?.success && polled.refreshToken) break;
        if (polled?.expired) {
          throw new Error('Device code expired before sign-in completed.');
        }
        if (!polled?.pending && !polled?.slowDown) {
          // hard error
          if (polled?.error && polled.error !== 'authorization_pending') {
            throw new Error(polled.message || polled.error || 'Device code poll failed');
          }
        }
      }
      if (!polled?.success || !polled.refreshToken) {
        throw new Error('Device code never resolved before timeout');
      }

      setReauthState({ phase: 'completing' });
      const idTok: string | undefined = polled.idToken;
      const claims = idTok ? decodeJwtPayload(idTok) : null;
      const tenant = (claims?.tid as string) || 'common';

      // Swap the new (FOCI-eligible) RT onto the existing account.
      const swap = await window.electron.accounts.replaceTokenAuth(
        accountId,
        polled.refreshToken,
        tenant,
        DEFAULT_OFFICE_CLIENT_ID,
        'https://outlook.office.com',
        'ews'
      );
      if (!swap?.success) throw new Error('Failed to attach new refresh token to account');

      // Force a fresh PRT registration with the new RT.
      try { await window.electron.accounts.clearPrtRegistration(accountId); } catch { /* ignore */ }

      setReauthState({ phase: 'minting' });
      await mint();
      setReauthState({ phase: 'idle' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setReauthState({ phase: 'failed', message: msg });
    }
  };

  const handleCopy = async () => {
    if (!snippet) return;
    let ok = false;
    try {
      const r = await window.electron.clipboard.writeText(snippet);
      ok = !!r.success;
    } catch {
      /* try fallback */
    }
    if (!ok) {
      try {
        await navigator.clipboard.writeText(snippet);
        ok = true;
      } catch {
        /* try fallback */
      }
    }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = snippet;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      alert('Copy failed. Click inside the snippet box, press Ctrl/Cmd+A, then Ctrl/Cmd+C.');
    }
  };

  return (
    <div className="form-overlay" onClick={onCancel}>
      <div
        className="form-card"
        style={{
          maxWidth: 720,
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          background: '#1f2937',
          color: '#f9fafb',
          border: '1px solid #374151',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <h2 style={{ margin: 0, fontSize: 20 }}>
            <span style={{ marginRight: 8 }}>🔑</span>
            Generate document.cookie from token — {email}
          </h2>
          <button
            className="icon-btn"
            onClick={onCancel}
            style={{ background: 'transparent', color: '#f9fafb' }}
          >
            <i className="fas fa-times"></i>
          </button>
        </div>

        <div
          style={{
            background: '#1e3a8a33',
            border: '1px solid #1e40af',
            color: '#bfdbfe',
            borderRadius: 8,
            padding: 14,
            marginBottom: 14,
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: '#dbeafe' }}>Instructions:</strong>
          <div style={{ marginTop: 6, fontSize: 12, color: '#dbeafe' }}>
            We mint a PRT cookie from this account's refresh token and build a ready-to-run
            <code style={{ marginLeft: 4 }}>document.cookie=...</code> snippet.
          </div>
          <ol style={{ margin: '8px 0 0 0', paddingLeft: 18 }}>
            <li>
              Open a new tab → navigate to{' '}
              <strong style={{ color: '#bfdbfe' }}>https://login.microsoftonline.com</strong>
            </li>
            <li>
              Open browser console (<strong style={{ color: '#bfdbfe' }}>F12 → Console</strong>)
            </li>
            <li>
              Click <strong style={{ color: '#bfdbfe' }}>Copy Snippet</strong> below
            </li>
            <li>Paste in console and press Enter</li>
            <li>
              You'll be redirected and signed in as <strong style={{ color: '#bfdbfe' }}>{email}</strong>
            </li>
          </ol>
        </div>

        {loading && (
          <div
            style={{
              background: '#1e3a8a33',
              border: '1px solid #1e40af',
              color: '#bfdbfe',
              borderRadius: 8,
              padding: 12,
              marginBottom: 12,
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <i className="fas fa-spinner fa-spin"></i>
            <span>
              Minting PRT cookie… (first time per account does device registration with Entra ID;
              subsequent calls are instant)
            </span>
          </div>
        )}

        {error && (
          <div
            style={{
              background: '#7f1d1d44',
              border: '1px solid #b91c1c',
              color: '#fecaca',
              borderRadius: 8,
              padding: 12,
              marginBottom: 12,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              lineHeight: 1.5,
            }}
          >
            <strong>Could not mint PRT cookie:</strong>
            <div style={{ marginTop: 6 }}>{error}</div>
            {/not FOCI-eligible|FOCI scope variants|broker FOCI client/i.test(error) && (
              <div style={{ marginTop: 8, padding: 10, background: '#1f2937', borderRadius: 4, color: '#fde68a' }}>
                <strong>Why this fails:</strong> AAD only mints PRT cookies via the FOCI
                cross-app exchange, and the refresh token on this account isn't FOCI-eligible
                (a property of the original sign-in grant — usually because the token came
                from a panel sync rather than Microsoft's own clients).
                <br /><br />
                <strong>One-click fix:</strong> sign in once via Device Code below. We swap
                the new (FOCI-eligible) token onto this exact account row and re-mint the
                PRT cookie automatically — you stay in this dialog the whole time.
                <br />
                {reauthState.phase === 'idle' && (
                  <button
                    type="button"
                    onClick={() => void handleInlineDeviceCode()}
                    style={{
                      marginTop: 10,
                      padding: '10px 14px',
                      background: '#2563eb',
                      color: '#fff',
                      border: 0,
                      borderRadius: 6,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    <i className="fas fa-key" style={{ marginRight: 8 }} />
                    Sign in once (Device Code) — auto-retry PRT
                  </button>
                )}
                {reauthState.phase === 'starting' && (
                  <div style={{ marginTop: 10 }}>
                    <i className="fas fa-spinner fa-spin" style={{ marginRight: 6 }} />
                    Requesting a device code from Microsoft…
                  </div>
                )}
                {reauthState.phase === 'awaiting' && (
                  <div style={{ marginTop: 10, padding: 10, background: '#0f172a', borderRadius: 6, color: '#bfdbfe' }}>
                    Microsoft asks you to enter this code:
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#fff', textAlign: 'center', margin: '8px 0', letterSpacing: 2, padding: '8px', background: '#1e3a8a', borderRadius: 6 }}>
                      {reauthState.userCode}
                    </div>
                    at <strong style={{ color: '#fff' }}>{reauthState.verificationUri}</strong>
                    <br />
                    <span style={{ fontSize: 11 }}>(opened automatically in your default browser)</span>
                    <div style={{ marginTop: 8, fontSize: 12 }}>
                      <i className="fas fa-spinner fa-spin" style={{ marginRight: 6 }} />
                      Waiting for sign-in…
                    </div>
                  </div>
                )}
                {reauthState.phase === 'completing' && (
                  <div style={{ marginTop: 10 }}>
                    <i className="fas fa-spinner fa-spin" style={{ marginRight: 6 }} />
                    Sign-in complete — attaching new token to this account…
                  </div>
                )}
                {reauthState.phase === 'minting' && (
                  <div style={{ marginTop: 10 }}>
                    <i className="fas fa-spinner fa-spin" style={{ marginRight: 6 }} />
                    Minting fresh PRT cookie with the new token…
                  </div>
                )}
                {reauthState.phase === 'failed' && (
                  <div style={{ marginTop: 10, padding: 8, background: '#7f1d1d44', borderRadius: 4, color: '#fecaca', fontSize: 12 }}>
                    Re-auth failed: {reauthState.message}
                    <br />
                    <button
                      type="button"
                      onClick={() => setReauthState({ phase: 'idle' })}
                      style={{ marginTop: 6, padding: '4px 10px', background: '#374151', color: '#f9fafb', border: 0, borderRadius: 4, fontSize: 11, cursor: 'pointer' }}
                    >
                      Dismiss
                    </button>
                  </div>
                )}
                <em style={{ display: 'block', marginTop: 10, fontSize: 11 }}>
                  Alternative: <strong>Export cookies → Capture browser cookies</strong> works
                  on this account today without Device Code (one interactive sign-in, then
                  ~90-day exports).
                </em>
              </div>
            )}
            {/AADSTS50158|AADSTS500011|compliant|hybrid joined|conditional access/i.test(error) && (
              <div style={{ marginTop: 8, padding: 8, background: '#1f2937', borderRadius: 4 }}>
                <strong style={{ color: '#fde68a' }}>Why this fails:</strong> the tenant requires
                Intune-compliant or hybrid-joined devices for sign-in. Our newly-registered device
                is neither, so AAD blocks the srv_challenge step. The captured-cookie path
                (Export cookies → Capture browser cookies) is your only route in this tenant.
              </div>
            )}
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => void mint()}
                style={{
                  padding: '6px 12px',
                  background: '#374151',
                  color: '#f9fafb',
                  border: 0,
                  borderRadius: 6,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                <i className="fas fa-redo" style={{ marginRight: 6 }} /> Retry
              </button>
              <button
                type="button"
                onClick={() => void handleClearAndRetry()}
                style={{
                  padding: '6px 12px',
                  background: '#374151',
                  color: '#f9fafb',
                  border: 0,
                  borderRadius: 6,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                <i className="fas fa-trash" style={{ marginRight: 6 }} /> Forget device & retry
              </button>
            </div>
          </div>
        )}

        {snapshot && !error && (
          <div
            style={{
              background: '#064e3b44',
              border: '1px solid #047857',
              color: '#a7f3d0',
              borderRadius: 8,
              padding: 10,
              marginBottom: 12,
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            ✓ <strong>PRT cookie minted</strong> · device <code>{snapshot.deviceId.slice(0, 8)}…</code>{' '}
            in tenant <code>{snapshot.tenantId.slice(0, 8)}…</code> · valid until{' '}
            <strong>{new Date(snapshot.expiresAt).toLocaleString()}</strong>
            <br />
            <span style={{ color: '#fde68a', fontSize: 11 }}>
              ⚠ A device record was created in this tenant's Entra ID Devices list. Click
              "Forget device & retry" if you need to re-register.
            </span>
          </div>
        )}

        <textarea
          readOnly
          value={loading ? 'Loading…' : snippet}
          spellCheck={false}
          onFocus={e => e.currentTarget.select()}
          style={{
            flex: 1,
            minHeight: 280,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: 11,
            lineHeight: 1.5,
            background: '#111827',
            color: '#e5e7eb',
            border: '1px solid #374151',
            borderRadius: 8,
            padding: 12,
            resize: 'vertical',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        />

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button
            type="button"
            onClick={() => void handleCopy()}
            disabled={loading || !snippet}
            style={{
              flex: 1,
              padding: '12px 18px',
              background: copied ? '#059669' : '#2563eb',
              color: '#fff',
              border: 0,
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: loading || !snippet ? 'not-allowed' : 'pointer',
              transition: 'background 0.15s',
            }}
          >
            <i className={`fas ${copied ? 'fa-check' : 'fa-copy'}`} style={{ marginRight: 8 }} />
            {copied ? 'Copied!' : 'Copy Snippet'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '12px 24px',
              background: '#374151',
              color: '#f9fafb',
              border: 0,
              borderRadius: 8,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default BrowserCookiesSnippetModal;
