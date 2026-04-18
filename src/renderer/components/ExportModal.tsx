import React, { useState } from 'react';

interface ExportModalProps {
  accountId?: string | null;
  selectedAccounts?: string[];
  onCancel: () => void;
}

const ExportModal: React.FC<ExportModalProps> = ({ accountId, selectedAccounts, onCancel }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportData, setExportData] = useState<string>('');

  const isBulk = selectedAccounts && selectedAccounts.length > 0;
  const targetCount = isBulk ? selectedAccounts.length : 1;

  const handleExport = async () => {
    console.log('handleExport called, window.electron.tokens:', window.electron?.tokens);
    console.log('exportJSONData:', window.electron?.tokens?.exportJSONData);
    setLoading(true);
    setError(null);
    try {
      const accountIds = isBulk ? selectedAccounts : accountId ? [accountId] : [];
      console.log('Exporting account IDs:', accountIds);
      // Call IPC to export token data
      const result = await window.electron.tokens.exportJSONData(accountIds);
      console.log('Export result:', result);
      if (!result.success) {
        throw new Error(result.error || 'Export failed');
      }
      if (result.count === 0) {
        throw new Error('No token accounts found to export. Make sure the selected account uses a refresh token (look for "Token" system tag).');
      }
      setExportData(JSON.stringify(result.data, null, 2));
      // Don't call onSuccess - keep modal open to show JSON and copy/download buttons
    } catch (err) {
      console.error('Export error:', err);
      const errMsg = err instanceof Error ? err.message : String(err);
      setError(errMsg);
      // Temporary alert for debugging
      alert(`Export failed: ${errMsg}`);
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
          </div>
        )}
      </div>
    </div>
  );
};

export default ExportModal;