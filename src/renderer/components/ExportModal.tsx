import React, { useState } from 'react';

interface ExportModalProps {
  accountId?: string | null;
  selectedAccounts?: string[];
  onSuccess?: () => void;
  onCancel: () => void;
}

const ExportModal: React.FC<ExportModalProps> = ({ accountId, selectedAccounts, onSuccess, onCancel }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportData, setExportData] = useState<string>('');

  const isBulk = selectedAccounts && selectedAccounts.length > 0;
  const targetCount = isBulk ? selectedAccounts.length : 1;

  const handleExport = async () => {
    setLoading(true);
    setError(null);
    try {
      // Call IPC to export tokens
      const result = await window.electron.actions.exportTokens({
        accountIds: isBulk ? selectedAccounts : accountId ? [accountId] : [],
        format: 'json',
      });
      if (!result.success) {
        throw new Error(result.message || 'Export failed');
      }
      setExportData(JSON.stringify(result.data, null, 2));
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(exportData)
      .then(() => alert('Copied to clipboard'))
      .catch(() => alert('Copy failed'));
  };

  const handleDownload = () => {
    const blob = new Blob([exportData], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tokens-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" style={{ maxWidth: '600px' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <h2 className="modal-title" style={{ marginBottom: 0 }}>
            {isBulk ? `Export Tokens (${targetCount} accounts)` : 'Export Tokens'}
          </h2>
          <button className="icon-btn" onClick={onCancel}>
            <i className="fas fa-times"></i>
          </button>
        </div>

        <div className="mb-6">
          <p className="text-gray-700 mb-4">
            Export refresh tokens for {isBulk ? `${targetCount} selected accounts` : 'this account'}.
            Tokens are encrypted with your local key and can be imported into another instance of this app.
          </p>

          {exportData ? (
            <div className="space-y-4">
              <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
                <pre className="text-xs overflow-auto max-h-60">{exportData}</pre>
              </div>
              <div className="flex gap-3">
                <button className="form-btn secondary" onClick={handleCopy}>
                  <i className="fas fa-copy mr-2"></i> Copy JSON
                </button>
                <button className="form-btn secondary" onClick={handleDownload}>
                  <i className="fas fa-download mr-2"></i> Download File
                </button>
                <button className="form-btn cancel" onClick={() => setExportData('')}>
                  <i className="fas fa-redo mr-2"></i> New Export
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center p-8 border-2 border-dashed border-gray-300 rounded-xl">
              <i className="fas fa-file-export text-4xl text-gray-400 mb-4"></i>
              <p className="text-gray-600 mb-6">
                Click the button below to generate a secure export file containing the refresh tokens.
              </p>
              <button
                className="form-btn save"
                onClick={handleExport}
                disabled={loading}
              >
                {loading ? (
                  <>
                    <i className="fas fa-spinner fa-spin mr-2"></i> Exporting...
                  </>
                ) : (
                  <>
                    <i className="fas fa-file-export mr-2"></i> Export Tokens
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            <strong>Error:</strong> {error}
          </div>
        )}

        {!exportData && (
          <div className="flex justify-end gap-3">
            <button
              className="form-btn cancel"
              onClick={onCancel}
              disabled={loading}
            >
              Cancel
            </button>
            <button
              className="form-btn save"
              onClick={handleExport}
              disabled={loading}
            >
              {loading ? (
                <>
                  <i className="fas fa-spinner fa-spin mr-2"></i> Exporting...
                </>
              ) : (
                <>
                  <i className="fas fa-file-export mr-2"></i> Export Tokens
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ExportModal;