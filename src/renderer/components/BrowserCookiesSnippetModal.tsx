import React, { useEffect, useState } from 'react';

interface BrowserCookiesSnippetModalProps {
  accountId: string;
  email: string;
  onCancel: () => void;
}

type SnapshotData = {
  email: string;
  count: number;
  strongCount: number;
  source: 'realBrowser' | 'tokenPartition';
  capturedAt?: string;
  // Raw cookies-as-JSON. We render it as a one-line `document.cookie=…`
  // snippet client-side so the user can re-copy without another IPC
  // round-trip.
  extensionJson: string;
};

/** Build a single-line `document.cookie="…"` console snippet, mirroring the
 *  PRT-cookie style the user wants but using captured ESTSAUTH cookies (the
 *  closest thing AAD will let us deliver without a registered device).
 *
 *  document.cookie can only set ONE cookie per assignment, so we emit a
 *  semicolon-separated list of statements. Browsers silently drop HttpOnly
 *  cookies set this way, but the bridge cookies that survive are usually
 *  enough to flip AAD's /authorize?prompt=none into a successful redirect
 *  for the freshest captures.
 *
 *  After all cookies are written we also navigate to /authorize so the
 *  user lands directly on the inbox — same UX as the user's reference
 *  screenshot. */
function buildOneLinerSnippet(extensionJson: string, email: string): string {
  let cookies: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(extensionJson);
    if (Array.isArray(parsed)) cookies = parsed as Array<Record<string, unknown>>;
  } catch {
    /* leave empty */
  }
  // Prefer cookies that AAD will actually accept on login.microsoftonline.com
  // - any with a domain that ends in microsoftonline.com / live.com /
  // microsoft.com. The console snippet is run on login.microsoftonline.com
  // so others would be rejected as cross-domain anyway.
  const isAadHost = (d: unknown) => {
    const s = String(d || '').replace(/^\./, '').toLowerCase();
    return (
      s === 'login.microsoftonline.com' ||
      s.endsWith('.microsoftonline.com') ||
      s.endsWith('.microsoft.com') ||
      s === 'login.live.com' ||
      s.endsWith('.live.com')
    );
  };
  const writable = cookies.filter(c => !c.httpOnly && isAadHost(c.domain));
  // Build the exact `document.cookie=...; document.cookie=...;` chain the
  // screenshot uses, then append a redirect at the end.
  const parts: string[] = [];
  for (const c of writable) {
    const name = String(c.name || '');
    const value = String(c.value ?? '');
    if (!name) continue;
    const domain = String(c.domain || '').replace(/^\./, '');
    const path = (c.path as string) || '/';
    const secure = c.secure !== false ? '; secure' : '';
    const sameSite = (c.sameSite as string) || 'no_restriction';
    const sameSiteAttr =
      sameSite === 'lax' ? '; SameSite=Lax' : sameSite === 'strict' ? '; SameSite=Strict' : '; SameSite=None';
    const expires =
      typeof c.expirationDate === 'number' && c.expirationDate > 0
        ? `; expires=${new Date(c.expirationDate * 1000).toUTCString()}`
        : '; max-age=31536000';
    parts.push(
      `document.cookie="${name}=${value}; domain=${domain}; path=${path}${secure}${sameSiteAttr}${expires}"`
    );
  }
  // Final redirect to /oauth2/v2.0/authorize?prompt=none — if the bridge
  // cookies were enough, AAD silently lands the user on the inbox; if not
  // it shows the password page (which is the same outcome they'd get
  // without the snippet).
  const finalUrl =
    `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` +
    `?client_id=d3590ed6-52b3-4102-aeff-aad2292ab01c` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent('https://outlook.office.com/mail/')}` +
    `&response_mode=query` +
    `&scope=${encodeURIComponent('openid profile offline_access https://outlook.office.com/.default')}` +
    `&login_hint=${encodeURIComponent(email)}` +
    `&prompt=none`;
  parts.push(`location.href=${JSON.stringify(finalUrl)}`);
  return parts.join('; ');
}

const BrowserCookiesSnippetModal: React.FC<BrowserCookiesSnippetModalProps> = ({
  accountId,
  email,
  onCancel,
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotData | null>(null);
  const [snippet, setSnippet] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [capturing, setCapturing] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await window.electron.accounts.exportOwaCookies(accountId);
      if (!r.success) throw new Error(r.error || 'Export failed');
      setSnapshot({
        email: r.email,
        count: r.count,
        strongCount: r.strongCount,
        source: r.source,
        capturedAt: r.capturedAt,
        extensionJson: r.extensionJson,
      });
      setSnippet(buildOneLinerSnippet(r.extensionJson, r.email));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const handleCapture = async () => {
    if (capturing) return;
    setCapturing(true);
    setError(null);
    try {
      const cap = await window.electron.accounts.captureRealBrowserCookies(accountId);
      if (!cap.success) throw new Error(cap.error || 'Capture failed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCapturing(false);
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

  const isReal = snapshot?.source === 'realBrowser';

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

        {!isReal && !loading && (
          <div
            style={{
              background: '#7f1d1d44',
              border: '1px solid #b91c1c',
              color: '#fecaca',
              borderRadius: 8,
              padding: 12,
              marginBottom: 12,
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            <strong>⚠ No real-browser cookies captured yet.</strong> The snippet below is built from
            our in-app token-partition cookies, which do not include the AAD <code>ESTSAUTH</code>
            session cookie — pasting this in a fresh browser will land on the AAD sign-in page
            instead of the inbox.
            <br />
            <br />
            <strong>Fix:</strong> click the button below to do a one-time interactive sign-in. We
            capture the resulting <code>ESTSAUTH</code>/<code>ESTSAUTHPERSISTENT</code> cookies and
            this snippet starts working in any OS browser.
            <br />
            <button
              type="button"
              className="form-btn save"
              style={{ marginTop: 8, background: '#dc2626', color: '#fff' }}
              onClick={() => void handleCapture()}
              disabled={capturing}
            >
              <i className={`fas ${capturing ? 'fa-spinner fa-spin' : 'fa-key'}`} style={{ marginRight: 6 }} />
              {capturing ? 'Waiting for sign-in…' : 'Capture browser cookies (one-time sign-in)'}
            </button>
          </div>
        )}

        {isReal && snapshot && (
          <div
            style={{
              background: '#064e3b44',
              border: '1px solid #047857',
              color: '#a7f3d0',
              borderRadius: 8,
              padding: 10,
              marginBottom: 12,
              fontSize: 12,
            }}
          >
            ✓ <strong>{snapshot.count}</strong> cookies captured ·{' '}
            <strong>{snapshot.strongCount}</strong> primary auth
            {snapshot.capturedAt && (
              <>
                {' '}· captured <strong>{new Date(snapshot.capturedAt).toLocaleString()}</strong>
              </>
            )}
          </div>
        )}

        {error && (
          <div
            style={{
              background: '#7f1d1d44',
              border: '1px solid #b91c1c',
              color: '#fecaca',
              borderRadius: 8,
              padding: 10,
              marginBottom: 12,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
            }}
          >
            <strong>Error:</strong> {error}
          </div>
        )}

        <textarea
          readOnly
          value={loading ? 'Loading captured cookies…' : snippet}
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
