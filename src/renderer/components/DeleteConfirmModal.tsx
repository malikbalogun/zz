import React from 'react';
import { bulkDeleteAccounts } from '../services/accountService';

interface DeleteConfirmModalProps {
  selectedAccounts: string[];
  onSuccess?: () => void;
  onCancel: () => void;
}

const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({ selectedAccounts, onSuccess, onCancel }) => {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleConfirm = async () => {
    if (selectedAccounts.length === 0) {
      onCancel();
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await bulkDeleteAccounts(selectedAccounts);
      // Notify App to update sidebar badge
      window.dispatchEvent(new CustomEvent('accounts-changed'));
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" style={{ maxWidth: '400px' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <h2 className="modal-title" style={{ marginBottom: 0 }}>Confirm Delete</h2>
          <button className="icon-btn" onClick={onCancel}>
            <i className="fas fa-times"></i>
          </button>
        </div>

        <div className="mb-6">
          <p className="text-gray-700">
            Are you sure you want to delete <strong>{selectedAccounts.length}</strong> selected account(s)?
          </p>
          <p className="text-sm text-gray-500 mt-2">
            This action cannot be undone. The accounts will be removed from this app, but tokens may still be valid until they expire.
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            <strong>Error:</strong> {error}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button
            className="form-btn cancel"
            onClick={onCancel}
            disabled={loading}
          >
            Cancel
          </button>
          <button
            className="form-btn danger"
            onClick={handleConfirm}
            disabled={loading}
          >
            {loading ? (
              <>
                <i className="fas fa-spinner fa-spin mr-2"></i> Deleting...
              </>
            ) : (
              <>
                <i className="fas fa-trash mr-2"></i> Delete
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeleteConfirmModal;