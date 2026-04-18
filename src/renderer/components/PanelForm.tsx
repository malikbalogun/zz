import React, { useState } from 'react';
import * as panelService from '../services/panelService';

export type PanelFormPayload = {
  name: string;
  url: string;
  username: string;
  /** Required for new panels; omit or leave blank when editing to keep stored password */
  password?: string;
};

interface PanelFormProps {
  onSuccess?: (data: PanelFormPayload) => void | Promise<void>;
  onCancel?: () => void;
  initialData?: {
    name?: string;
    url?: string;
    username?: string;
    password?: string;
  };
}

const PanelForm: React.FC<PanelFormProps> = ({ onSuccess, onCancel, initialData }) => {
  const isEdit = initialData != null;
  const [name, setName] = useState(initialData?.name || '');
  const [url, setUrl] = useState(initialData?.url || '');
  const [username, setUsername] = useState(initialData?.username || '');
  const [password, setPassword] = useState(initialData?.password || '');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleTest = async () => {
    if (!url || !username || !password) {
      setError('URL, username, and password are required');
      return;
    }
    setTesting(true);
    setError(null);
    setSuccess(null);
    try {
      const token = await panelService.testPanelConnection(url, username, password);
      setSuccess(`Connection successful! Token received (${token.substring(0, 20)}…)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !url.trim() || !username.trim()) {
      setError('Name, URL, and username are required');
      return;
    }
    if (!isEdit && !password) {
      setError('Password is required');
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const payload: PanelFormPayload = {
        name: name.trim(),
        url: url.trim(),
        username: username.trim(),
        ...(password ? { password } : {}),
      };
      if (onSuccess) {
        await Promise.resolve(onSuccess(payload));
      }
      setSuccess(isEdit ? 'Panel updated' : 'Panel saved');
      if (!isEdit) {
        setName('');
        setUrl('');
        setUsername('');
        setPassword('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="form-card">
      <h2 className="form-title">{isEdit ? 'Edit Panel' : 'Add Panel'}</h2>
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label className="form-label">Panel Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="form-input"
            placeholder="My Webmail Panel"
            required
          />
        </div>
        <div className="form-group">
          <label className="form-label">Panel URL</label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="form-input"
            placeholder="https://panel.example.com"
            required
          />
          <div className="form-helper">Include https:// - no trailing slash</div>
        </div>
        <div className="form-group">
          <label className="form-label">Admin Username</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="form-input"
            placeholder="admin"
            required
          />
        </div>
        <div className="form-group">
          <label className="form-label">Admin Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="form-input"
            placeholder={isEdit ? 'Leave blank to keep current password' : ''}
            required={!isEdit}
            autoComplete="new-password"
          />
          {isEdit && (
            <div className="form-helper">Optional — only fill in to change the stored password</div>
          )}
        </div>

        {error && (
          <div className="mt-6 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
            <strong>Error:</strong> {error}
          </div>
        )}
        {success && (
          <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-xl text-green-700 text-sm">
            <strong>Success:</strong> {success}
          </div>
        )}

        <div className="form-actions">
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="form-btn test"
          >
            <i className="fas fa-plug"></i> {testing ? 'Testing…' : 'Test Connection'}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="form-btn save"
          >
            <i className="fas fa-save"></i> {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Save Panel'}
          </button>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="form-btn cancel"
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
};

export default PanelForm;