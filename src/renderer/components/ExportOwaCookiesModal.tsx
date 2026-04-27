import React, { useEffect, useState } from 'react';

type FormatKind = 'editor' | 'netscape';

interface ExportOwaCookiesModalProps {
  accountId: string;
  emailHint?: string;
  onClose: () => void;
}

interface ExportPayload {
  count: number;
  strongCount: number;
  httpOnlyCount: number;
  weak: boolean;
  email: string;
  netscape: string;
  cookieEditorJson: string;
}

/**
 * Export OWA cookies in browser-importable formats.
 * JSON is intended for extensions like EditThisCookie/Cookie-Editor.
 */
const ExportOwaCookiesModal: React.FC<ExportOwaCookiesModalProps> = ({
  accountId,
  emailHint,
  onClose,
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ExportPayload | null>(null);
  const [format, setFormat] = useState<FormatKind>('editor');
  const [copied, setCopied] = useState<FormatKind | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await window.electron.accounts.exportOwaCookies(accountId);
        if (cancelled) return;
        if (!result.success) {
          throw new Error(result.error || 'Export failed');
        }
        setData({
          count: result.count ?? 0,
          strongCount: result.strongCount ?? 0,
          httpOnlyCount: result.httpOnlyCount ?? 0,
          weak: !!result.weak,
          email: result.email || emailHint || '',
          netscape: result.netscape || '',
          cookieEditorJson: result.cookieEditorJson || '',
        });
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
  }, [accountId, emailHint]);

  const currentText = !data ? '' : format === 'editor' ? data.cookieEditorJson : data.netscape;

  const handleCopy = async () => {
    if (!currentText) return;
    try {
      await navigator.clipboard.writeText(currentText);
      setCopied(format);
      setTimeout(() => setCopied((c) => (c === format ? null : c)), 1500);
    } catch {
      window.prompt('Copy manually:', currentText);
    }
  };

  const handleSaveFile = async () => {
    if (!data) return;
    const safeEmail = (data.email || 'account').replace(/[^a-z0-9._-]+/gi, '_');
    const date = new Date().toISOString().slice(0, 10);
    const meta =
      format === 'editor'
        ? { ext: 'json', label: 'Cookie JSON', filters: [{ name: 'JSON', extensions: ['json'] }] }
        : { ext: 'txt', label: 'Netscape Cookie File', filters: [{ name: 'Netscape Cookie File', extensions: ['txt', 'cookies'] }] };

    try {
      const saved = await window.electron.files.saveTextWithDialog({
        defaultFilename: `${safeEmail}-cookies-${date}.${meta.ext}`,
        content: currentText,
        filters: [...meta.filters, { name: 'All files', extensions: ['*'] }],
      });
      if (saved.ok) {
        alert(`Saved ${meta.label} to ${saved.path}`);
      }
    } catch (e) {
      alert(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const tabBtnStyle = (active: boolean): React.CSSProperties => ({
    padding: '6px 12px',
    border: '1px solid ' + (active ? '#3b82f6' : '#d1d5db'),
    background: active ? '#eff6ff' : '#fff',
    color: active ? '#1d4ed8' : '#374151',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
  });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        style={{ maxWidth: 760, width: '90vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 16,
          }}
        >
          <h2 className="modal-title" style={{ marginBottom: 0 }}>
            <i className="fas fa-cookie" style={{ marginRight: 8 }} />
            Export cookies JSON ({emailHint || data?.email || ''})
          </h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <i className="fas fa-times" />
          </button>
        </div>

        {loading && (
          <div style={{ padding: 32, textAlign: 'center', color: '#6b7280' }}>
            <i className="fas fa-spinner fa-spin" style={{ marginRight: 8 }} />
            Capturing OWA cookies (this may take up to ~12 seconds the first time).
          </div>
        )}

        {!loading && error && (
          <div
            style={{
              padding: 12,
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#991b1b',
              borderRadius: 8,
              fontSize: 13,
              whiteSpace: 'pre-wrap',
            }}
          >
            <strong>Export failed:</strong>
            {'\n'}
            {error}
          </div>
        )}

        {!loading && !error && data && (
          <>
            <div
              style={{
                display: 'flex',
                gap: 12,
                flexWrap: 'wrap',
                marginBottom: 12,
                fontSize: 12,
                color: '#4b5563',
              }}
            >
              <span>
                <strong>{data.count}</strong> cookies captured
              </span>
              <span>
                <strong>{data.strongCount}</strong> strong auth
              </span>
              <span>
                <strong>{data.httpOnlyCount}</strong> HttpOnly
              </span>
              {data.weak && (
                <span style={{ color: '#b45309' }}>
                  <i className="fas fa-exclamation-triangle" style={{ marginRight: 4 }} />
                  Weak export - open in-app Outlook once first.
                </span>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button
                style={tabBtnStyle(format === 'editor')}
                onClick={() => setFormat('editor')}
                title="Cookie-Editor / EditThisCookie compatible JSON."
              >
                Cookie JSON
              </button>
              <button
                style={tabBtnStyle(format === 'netscape')}
                onClick={() => setFormat('netscape')}
                title="curl / Netscape HTTP Cookie File."
              >
                Netscape file
              </button>
            </div>

            <div
              style={{
                fontSize: 12,
                color: '#4b5563',
                marginBottom: 8,
                lineHeight: 1.5,
              }}
            >
              {format === 'editor' && (
                <span>
                  Import this JSON with browser extensions like <strong>EditThisCookie</strong> or <strong>Cookie-Editor</strong>.
                </span>
              )}
              {format === 'netscape' && (
                <span>
                  Standard <code>curl --cookie</code> / <code>wget --load-cookies</code> format.
                </span>
              )}
            </div>

            <textarea
              readOnly
              value={currentText}
              style={{
                width: '100%',
                height: 240,
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                fontSize: 12,
                padding: 10,
                border: '1px solid #d1d5db',
                borderRadius: 6,
                background: '#f9fafb',
                resize: 'vertical',
              }}
              onFocus={(e) => e.currentTarget.select()}
            />

            <div
              style={{
                display: 'flex',
                gap: 8,
                marginTop: 12,
                justifyContent: 'flex-end',
                flexWrap: 'wrap',
              }}
            >
              <button className="form-btn secondary" onClick={handleSaveFile}>
                <i className="fas fa-download" style={{ marginRight: 6 }} />
                Save to file
              </button>
              <button className="form-btn save" onClick={handleCopy}>
                <i
                  className={'fas ' + (copied === format ? 'fa-check' : 'fa-copy')}
                  style={{ marginRight: 6 }}
                />
                {copied === format ? 'Copied!' : 'Copy to clipboard'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default ExportOwaCookiesModal;
