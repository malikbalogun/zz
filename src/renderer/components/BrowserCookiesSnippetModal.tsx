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
            Browser Cookies — {email}
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
