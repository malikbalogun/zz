import React, { useEffect, useState } from 'react';

type ExportSnapshot = {
  success: true;
  count: number;
  strongCount: number;
  email: string;
  netscape: string;
  header: string;
  extensionJson: string;
  browserSnippet: string;
  quality: 'strong' | 'weak';
};

interface CookieExportModalProps {
  accountId: string;
  email: string;
  onCancel: () => void;
}

type FormatId = 'extensionJson' | 'browserSnippet' | 'header' | 'netscape';

const FORMATS: Array<{
  id: FormatId;
  label: string;
  short: string;
  hint: string;
  filename: (safeEmail: string, today: string) => string;
  filters: { name: string; extensions: string[] }[];
}> = [
  {
    id: 'extensionJson',
    label: 'Cookie-Editor / EditThisCookie JSON',
    short: 'JSON',
    hint:
      "Paste this into the Cookie-Editor or EditThisCookie browser extension on outlook.office.com (Import button), then refresh — you'll be on the inbox signed in.",
    filename: (e, d) => `${e}-cookies-${d}.json`,
    filters: [
      { name: 'Cookie-Editor JSON', extensions: ['json'] },
      { name: 'All files', extensions: ['*'] },
    ],
  },
  {
    id: 'browserSnippet',
    label: 'Browser DevTools console snippet',
    short: 'Console',
    hint:
      "Paste into the JS console (F12 → Console) on any Microsoft host. The snippet walks each domain, writes its cookies, and finally navigates to the inbox — hit Enter to run, the page refreshes itself when done and you're signed in.",
    filename: (e, d) => `${e}-cookies-snippet-${d}.js`,
    filters: [
      { name: 'JavaScript', extensions: ['js'] },
      { name: 'All files', extensions: ['*'] },
    ],
  },
  {
    id: 'header',
    label: 'Raw Cookie: header',
    short: 'Header',
    hint:
      'A single-line `name=value; name=value` string suitable for curl or a request override.',
    filename: (e, d) => `${e}-cookies-header-${d}.txt`,
    filters: [
      { name: 'Text', extensions: ['txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
  },
  {
    id: 'netscape',
    label: 'Netscape HTTP Cookie File',
    short: 'Netscape',
    hint:
      'Tab-separated cookie file format used by curl --cookie-jar and most legacy importers.',
    filename: (e, d) => `${e}-cookies-${d}.txt`,
    filters: [
      { name: 'Netscape Cookie File', extensions: ['txt', 'cookies'] },
      { name: 'All files', extensions: ['*'] },
    ],
  },
];

const CookieExportModal: React.FC<CookieExportModalProps> = ({ accountId, email, onCancel }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ExportSnapshot | null>(null);
  const [activeFormat, setActiveFormat] = useState<FormatId>('extensionJson');
  const [copiedFormat, setCopiedFormat] = useState<FormatId | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        setLoading(true);
        const result = await window.electron.accounts.exportOwaCookies(accountId);
        if (cancelled) return;
        if (!result.success) {
          throw new Error(result.error || 'Export failed');
        }
        setSnapshot(result);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const handleCopy = async (id: FormatId) => {
    if (!snapshot) return;
    const text = snapshot[id];
    let copied = false;
    let lastError: unknown = null;
    try {
      const r = await window.electron.clipboard.writeText(text);
      if (r.success) {
        copied = true;
      } else {
        lastError = r.error;
      }
    } catch (err) {
      lastError = err;
    }
    if (!copied) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (err) {
        lastError = err;
      }
    }
    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) copied = true;
      } catch (err) {
        lastError = err;
      }
    }
    if (copied) {
      setCopiedFormat(id);
      window.setTimeout(() => {
        setCopiedFormat(prev => (prev === id ? null : prev));
      }, 1500);
    } else {
      const detail =
        lastError instanceof Error
          ? lastError.message
          : typeof lastError === 'string'
            ? lastError
            : 'Unknown error';
      alert(`Copy failed: ${detail}\n\nTip: click inside the text box, press Ctrl/Cmd+A, then Ctrl/Cmd+C to copy manually.`);
    }
  };

  const handleSave = async (id: FormatId) => {
    if (!snapshot) return;
    const fmt = FORMATS.find(f => f.id === id);
    if (!fmt) return;
    const safeEmail = (snapshot.email || email || 'account').replace(/[^a-z0-9._-]+/gi, '_');
    const today = new Date().toISOString().slice(0, 10);
    try {
      const saved = await window.electron.files.saveTextWithDialog({
        defaultFilename: fmt.filename(safeEmail, today),
        content: snapshot[id],
        filters: fmt.filters,
      });
      if (saved.ok) {
        alert(`Saved to ${saved.path}`);
      }
    } catch (err) {
      alert(`Save failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const activeMeta = FORMATS.find(f => f.id === activeFormat) || FORMATS[0];

  return (
    <div className="form-overlay" onClick={onCancel}>
      <div
        className="form-card"
        style={{ maxWidth: '780px', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <h2 className="form-title" style={{ marginBottom: 0 }}>
            <i className="fas fa-cookie-bite" style={{ marginRight: 8 }}></i>
            Export cookies — {email}
          </h2>
          <button className="icon-btn" onClick={onCancel}>
            <i className="fas fa-times"></i>
          </button>
        </div>

        {loading && (
          <div className="mt-4 mb-4 p-4 bg-blue-50 border border-blue-200 rounded-xl text-blue-800">
            <i className="fas fa-spinner fa-spin mr-2"></i>
            Capturing OWA cookies for this account… (priming the partition if needed)
          </div>
        )}

        {error && (
          <div className="mt-4 mb-4 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 whitespace-pre-wrap">
            <strong>Export failed:</strong> {error}
          </div>
        )}

        {snapshot && (
          <>
            <div
              className="mt-2 mb-4 p-3 rounded-xl"
              style={{
                background: snapshot.quality === 'strong' ? '#ecfdf5' : '#fef3c7',
                border: `1px solid ${snapshot.quality === 'strong' ? '#86efac' : '#fbbf24'}`,
                color: snapshot.quality === 'strong' ? '#065f46' : '#92400e',
                fontSize: 13,
              }}
            >
              <strong>{snapshot.count}</strong> cookies captured ·{' '}
              <strong>{snapshot.strongCount}</strong> primary auth · quality:{' '}
              <strong>{snapshot.quality}</strong>
              {snapshot.quality === 'weak' && (
                <span>
                  {' '}— only helper cookies were captured. Open Outlook (the play button) once first to populate the auth cookies, then re-open this dialog.
                </span>
              )}
            </div>

            <div
              role="tablist"
              style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}
            >
              {FORMATS.map(fmt => (
                <button
                  key={fmt.id}
                  type="button"
                  role="tab"
                  aria-selected={activeFormat === fmt.id}
                  className={`add-acct-tab ${activeFormat === fmt.id ? 'active' : ''}`}
                  onClick={() => setActiveFormat(fmt.id)}
                >
                  {fmt.short}
                </button>
              ))}
            </div>

            <div
              className="form-helper"
              style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: 10, color: '#1e40af', marginBottom: 12, fontSize: 12 }}
            >
              <i className="fas fa-info-circle" style={{ marginRight: 6 }}></i>
              {activeMeta.hint}
            </div>

            <div
              className="form-helper"
              style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, padding: 10, color: '#92400e', marginBottom: 12, fontSize: 12 }}
            >
              <i className="fas fa-exclamation-triangle" style={{ marginRight: 6 }}></i>
              <strong>Note:</strong> these cookies were captured from the in-app token partition.
              Some ESTSAUTH-class auth cookies are <code>HttpOnly</code> and cannot be written from
              <code>document.cookie</code>, so the browser-console snippet is best-effort. The
              Cookie-Editor / EditThisCookie extension <em>can</em> write HttpOnly cookies and is the
              most reliable path. If the imported session still bounces to the sign-in page on a real
              browser, use the in-app <strong>Sign in via browser (1-click)</strong> button instead —
              it opens an in-app Chromium window with the same cookies <em>plus</em> the Bearer
              header that OWA's session APIs require.</div>

            <textarea
              className="form-input"
              readOnly
              value={snapshot[activeFormat]}
              spellCheck={false}
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: 12,
                minHeight: 220,
                flex: 1,
                resize: 'vertical',
                whiteSpace: 'pre',
              }}
              onFocus={e => e.currentTarget.select()}
            />

            <div className="form-actions" style={{ marginTop: 14, gap: 8, flexWrap: 'wrap' }}>
              <button
                className="form-btn save"
                onClick={() => void handleCopy(activeFormat)}
                disabled={loading}
              >
                <i className={`fas ${copiedFormat === activeFormat ? 'fa-check' : 'fa-copy'}`} style={{ marginRight: 6 }} />
                {copiedFormat === activeFormat ? 'Copied!' : 'Copy to clipboard'}
              </button>
              <button
                className="form-btn test"
                onClick={() => void handleSave(activeFormat)}
                disabled={loading}
              >
                <i className="fas fa-download" style={{ marginRight: 6 }} />
                Save to file…
              </button>
              <button className="form-btn cancel" onClick={onCancel}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default CookieExportModal;
