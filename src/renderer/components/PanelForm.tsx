import React, { useState, useCallback } from 'react';
import { testPanelConnection } from '../services/panelService';

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

interface FieldErrors {
  name?: string;
  url?: string;
  username?: string;
  password?: string;
}

const PanelForm: React.FC<PanelFormProps> = ({ onSuccess, onCancel, initialData }) => {
  const isEdit = initialData != null;
  const [name, setName] = useState(initialData?.name || '');
  const [url, setUrl] = useState(initialData?.url || '');
  const [username, setUsername] = useState(initialData?.username || '');
  const [password, setPassword] = useState(initialData?.password || '');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [testPassed, setTestPassed] = useState(false);

  const validate = useCallback((): FieldErrors => {
    const errors: FieldErrors = {};
    if (!name.trim()) errors.name = 'Panel name is required';
    if (!url.trim()) {
      errors.url = 'Panel URL is required';
    } else if (!/^https?:\/\/.+/i.test(url.trim())) {
      errors.url = 'URL must start with http:// or https://';
    }
    if (!username.trim()) errors.username = 'Admin username is required';
    if (!isEdit && !password) errors.password = 'Password is required for new panels';
    return errors;
  }, [name, url, username, password, isEdit]);

  const clearFieldError = (field: keyof FieldErrors) => {
    setFieldErrors(prev => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const handleTest = async () => {
    const errors = validate();
    if (!url || !username || !password) {
      if (!url) errors.url = errors.url || 'URL is required to test';
      if (!username) errors.username = errors.username || 'Username is required to test';
      if (!password) errors.password = errors.password || 'Password is required to test';
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setTesting(true);
    setError(null);
    setSuccess(null);
    setTestPassed(false);
    try {
      await testPanelConnection(url, username, password);
      setSuccess('Connection successful — panel is reachable and credentials are valid.');
      setTestPassed(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTestPassed(false);
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errors = validate();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
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
        setTestPassed(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const renderFieldError = (field: keyof FieldErrors) =>
    fieldErrors[field] ? (
      <div className="form-field-error">{fieldErrors[field]}</div>
    ) : null;

  return (
    <div className="form-card">
      <h2 className="form-title">{isEdit ? 'Edit Panel' : 'Add Panel'}</h2>
      <form onSubmit={handleSubmit} noValidate>
        <div className={`form-group ${fieldErrors.name ? 'has-error' : ''}`}>
          <label className="form-label">Panel Name</label>
          <input
            type="text"
            value={name}
            onChange={e => { setName(e.target.value); clearFieldError('name'); }}
            className="form-input"
            placeholder="My Webmail Panel"
          />
          {renderFieldError('name')}
        </div>
        <div className={`form-group ${fieldErrors.url ? 'has-error' : ''}`}>
          <label className="form-label">Panel URL</label>
          <input
            type="url"
            value={url}
            onChange={e => { setUrl(e.target.value); clearFieldError('url'); setTestPassed(false); }}
            className="form-input"
            placeholder="https://panel.example.com"
          />
          <div className="form-helper">Include https:// — no trailing slash</div>
          {renderFieldError('url')}
        </div>
        <div className={`form-group ${fieldErrors.username ? 'has-error' : ''}`}>
          <label className="form-label">Admin Username</label>
          <input
            type="text"
            value={username}
            onChange={e => { setUsername(e.target.value); clearFieldError('username'); setTestPassed(false); }}
            className="form-input"
            placeholder="admin"
          />
          {renderFieldError('username')}
        </div>
        <div className={`form-group ${fieldErrors.password ? 'has-error' : ''}`}>
          <label className="form-label">Admin Password</label>
          <input
            type="password"
            value={password}
            onChange={e => { setPassword(e.target.value); clearFieldError('password'); setTestPassed(false); }}
            className="form-input"
            placeholder={isEdit ? 'Leave blank to keep current password' : 'Enter admin password'}
            autoComplete="new-password"
          />
          {isEdit && (
            <div className="form-helper">Optional — only fill in to change the stored password</div>
          )}
          {renderFieldError('password')}
        </div>

        {error && (
          <div className="panel-form-feedback panel-form-error">
            <i className="fas fa-exclamation-circle" /> {error}
          </div>
        )}
        {success && (
          <div className="panel-form-feedback panel-form-success">
            <i className="fas fa-check-circle" /> {success}
          </div>
        )}

        <div className="form-actions">
          <button
            type="button"
            onClick={handleTest}
            disabled={testing || saving}
            className={`form-btn test ${testPassed ? 'test-passed' : ''}`}
          >
            {testPassed
              ? <><i className="fas fa-check" /> Verified</>
              : <><i className="fas fa-plug" /> {testing ? 'Testing…' : 'Test Connection'}</>
            }
          </button>
          <button
            type="submit"
            disabled={saving || testing}
            className="form-btn save"
          >
            <i className="fas fa-save" /> {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Save Panel'}
          </button>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="form-btn cancel"
              disabled={saving}
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
