import React, { useState, useEffect } from 'react';
import { getPanels, fetchAccounts } from '../services/panelService';
import { syncPanelAccounts } from '../services/accountSyncService';
import { getAccounts } from '../services/accountService';
import { getSettings } from '../services/settingsService';

import { normalizeCookiePasteToHeaderString } from '@shared/cookieFormat';
import type { MicrosoftAuthDiagnostic } from '@shared/microsoftAuthDiagnostics';



export type AddAccountInitialTab = 'panel' | 'cookie' | 'creds' | 'device' | 'json';

interface AddAccountModalProps {
  onSuccess?: () => void;
  onCancel: () => void;
  /** First tab shown when the modal mounts. */
  initialTab?: AddAccountInitialTab;
}

/** First-party Microsoft Office SPA — device code + OWA refresh use this client id. */
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

const AddAccountModal: React.FC<AddAccountModalProps> = ({ onSuccess, onCancel, initialTab }) => {
  const [activeTab, setActiveTab] = useState<AddAccountInitialTab>(() => initialTab ?? 'panel');
  const [panels, setPanels] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Device Code tab
  const [deviceCodeData, setDeviceCodeData] = useState<any>(null);
  const [polling, setPolling] = useState(false);
  const [deviceCodeError, setDeviceCodeError] = useState<string | null>(null);
  const [deviceCodeSuccess, setDeviceCodeSuccess] = useState<string | null>(null);

  // Panel Sync tab
  const [selectedPanelId, setSelectedPanelId] = useState('');
  const [previewAccounts, setPreviewAccounts] = useState<any[]>([]);

  // Cookie Import tab
  const [cookieEmail, setCookieEmail] = useState('');
  const [cookieData, setCookieData] = useState('');
  /** Optional on Credentials tab — passed as Microsoft `login_hint` when not using silent token bridge */
  const [credentialEmailHint, setCredentialEmailHint] = useState('');



  // Load panels on mount
  useEffect(() => {
    loadPanels();
  }, []);



  const loadPanels = async () => {
    try {
      const data = await getPanels();
      setPanels(data.filter(p => p.status === 'connected'));
    } catch (err) {
      console.error('Failed to load panels:', err);
    }
  };

  // Panel Sync: Preview accounts
  const handlePreviewAccounts = async () => {
    if (!selectedPanelId) {
      setError('Please select a panel');
      return;
    }
    setLoading(true);
    setError(null);
    setPreviewAccounts([]);
    try {
      const panel = panels.find(p => p.id === selectedPanelId);
      if (!panel) throw new Error('Panel not found');
      const remoteAccounts = await fetchAccounts(panel);
      const accounts = remoteAccounts.map(acc => ({
        email: acc.email,
        name: acc.name || acc.email.split('@')[0],
      }));
      setPreviewAccounts(accounts);
      setSuccess(`Found ${accounts.length} accounts`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // Panel Sync: Sync all accounts
  const handleSyncPanel = async () => {
    if (!selectedPanelId) {
      setError('Please select a panel');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const panel = panels.find(p => p.id === selectedPanelId);
      if (!panel) throw new Error('Panel not found');
      await syncPanelAccounts(panel.id);
      setSuccess('Accounts synced successfully');
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // Cookie Import: silent token→cookies when email matches a token account; else interactive capture
  const handleCaptureCookies = async (loginHint?: string) => {
    setLoading(true);
    setError(null);
    try {
      const hint = loginHint?.trim().toLowerCase();
      if (hint) {
        const list = await getAccounts();
        const tokenAcct = list.find(
          a => a.email.trim().toLowerCase() === hint && a.auth?.type === 'token'
        );
        if (tokenAcct) {
          const silent = await window.electron.accounts.hydrateSessionCookiesFromTokenEmail(hint);
          if (silent.success && silent.cookies) {
            setCookieData(silent.cookies);
            setSuccess(
              'Session cookies were built from your saved refresh token (no Microsoft login window). You can save as cookie account or convert to token.'
            );
            return;
          }
        }
      }
      const result = await window.electron.actions.captureCookies('https://login.microsoftonline.com/', {
        loginHint: loginHint?.trim() || undefined,
      });
      if (!result.success) {
        throw new Error(result.error || 'Cookie capture failed');
      }
      if (result.cookies) {
        setCookieData(result.cookies);
      }
      setSuccess(
        result.message ||
          'Microsoft session cookies captured. Review the cookie field, then save or convert to token.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // Cookie Import: Add account via cookies (stores encrypted cookie session)
  const handleAddViaCookies = async () => {
    if (!cookieEmail || !cookieData) {
      setError('Email and cookie data are required');
      return;
    }
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const header = normalizeCookiePasteToHeaderString(cookieData);
      if (!header) throw new Error('Could not parse cookies — use JSON array, Netscape export, or name=value; format');
      await window.electron.accounts.addViaCookies(cookieEmail.trim(), header);
      setSuccess('Account added via cookies (Cookie-Import tag). Use “Convert to token” for refresh token.');
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  /** OAuth PKCE window: cookies + authorize → refresh_token, then addViaToken */
  const handleConvertCookiesToToken = async () => {
    if (!cookieEmail || !cookieData) {
      setError('Email and cookie data are required');
      return;
    }
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const s = await getSettings();
      const ms = s.microsoftOAuth;
      const clientId = (ms?.clientId && ms.clientId.trim()) || DEFAULT_OFFICE_CLIENT_ID;
      const authority = (ms?.tenantId && ms.tenantId.trim()) || 'common';
      const redirectUri = (ms?.redirectUri && ms.redirectUri.trim()) || 'https://outlook.office.com/mail/';
      const result = (await window.electron.actions.exchangeCookiesForToken(cookieData, cookieEmail.trim(), {
        clientId,
        authority,
        redirectUri,
        showWindow: true,
      })) as {
        success?: boolean;
        refreshToken?: string;
        error?: string;
        diagnostics?: string;
        tenant?: string;
      };
      if (!result.success || !result.refreshToken) {
        const hint = result.diagnostics ? ` (${result.diagnostics})` : '';
        const base = (result.error || 'Conversion failed') + hint;
        const ad = (result as { authDiagnostic?: MicrosoftAuthDiagnostic }).authDiagnostic;
        if (ad) {
          throw new Error(
            `${base}\n\n${ad.title}${ad.aadstsCode ? ` (${ad.aadstsCode})` : ''}\n${ad.detail}\n${ad.suggestions.map((s: string) => `• ${s}`).join('\n')}`
          );
        }
        throw new Error(base);
      }
      const tenant = result.tenant || authority;
      await window.electron.accounts.addViaToken(
        cookieEmail.trim(),
        clientId,
        tenant,
        result.refreshToken,
        'ews'
      );
      setSuccess('Token account added from cookies (EWS scope).');
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // Import token accounts from JSON file
  const handleImportJson = async () => {
    console.log('handleImportJson called, window.electron.tokens:', window.electron?.tokens);
    console.log('importJSONDialog exists?', typeof window.electron?.tokens?.importJSONDialog);
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await window.electron.tokens.importJSONDialog();
      if (result.canceled) {
        setLoading(false);
        return;
      }
      if (!result.success) {
        throw new Error(result.error || 'Import failed');
      }
      setSuccess(`Successfully imported ${result.count} token account(s)`);
      onSuccess?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // Device Code: Start device code flow
  const handleStartDeviceCode = async () => {
    setDeviceCodeError(null);
    setDeviceCodeSuccess(null);
    setLoading(true);
    try {
      const result = await window.electron.microsoft.startDeviceCode();
      if (!result.success) throw new Error(result.error);
      setDeviceCodeData(result);
      setDeviceCodeSuccess('Device code generated. Enter the code at the verification URL.');
      // Start polling automatically
      setPolling(true);
    } catch (err) {
      setDeviceCodeError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // Device Code: Poll for token
  const handlePollDeviceCode = async () => {
    const dc = deviceCodeData?.deviceCode ?? deviceCodeData?.device_code;
    if (!dc) return;
    const pollIntervalSec = deviceCodeData.interval ?? 5;
    try {
      const result = await window.electron.microsoft.pollDeviceCode(
        dc,
        DEFAULT_OFFICE_CLIENT_ID,
        'common'
      );
      if (result.success && result.refreshToken) {
        setPolling(false);
        setDeviceCodeSuccess('Authentication successful! Adding account...');
        const idTok = (result as { idToken?: string }).idToken;
        const claims = idTok ? decodeJwtPayload(idTok) : null;
        const email =
          (claims?.preferred_username as string) ||
          (claims?.upn as string) ||
          (claims?.email as string) ||
          'unknown@example.com';
        const tenant = (claims?.tid as string) || 'common';
        await window.electron.accounts.addViaToken(
          email,
          DEFAULT_OFFICE_CLIENT_ID,
          tenant,
          result.refreshToken,
          'ews'
        );
        setDeviceCodeSuccess('Account added successfully');
        onSuccess?.();
      } else if ((result as { pending?: boolean }).pending) {
        setTimeout(handlePollDeviceCode, pollIntervalSec * 1000);
      } else if ((result as { slowDown?: boolean }).slowDown) {
        setTimeout(handlePollDeviceCode, pollIntervalSec * 2000);
      } else if ((result as { expired?: boolean }).expired) {
        setDeviceCodeError('Device code expired. Please start again.');
        setPolling(false);
      } else {
        setDeviceCodeError((result as { error?: string }).error || 'Polling failed');
        setPolling(false);
      }
    } catch (err) {
      setDeviceCodeError(err instanceof Error ? err.message : String(err));
      setPolling(false);
    }
  };

  // Polling effect
  useEffect(() => {
    const dc = deviceCodeData?.deviceCode ?? deviceCodeData?.device_code;
    if (polling && dc) {
      const timer = setTimeout(handlePollDeviceCode, (deviceCodeData.interval ?? 5) * 1000);
      return () => clearTimeout(timer);
    }
  }, [polling, deviceCodeData]);

  return (
    <div className="form-overlay" onClick={onCancel}>
      <div className="form-card" style={{ maxWidth: '560px' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <h2 className="form-title" style={{ marginBottom: 0 }}>Add Account</h2>
          <button className="icon-btn" onClick={onCancel}>
            <i className="fas fa-times"></i>
          </button>
        </div>

        {/* Tabs */}
        <div className="add-acct-tabs" style={{ flexWrap: 'wrap' }}>
          <button
            className={`add-acct-tab ${activeTab === 'panel' ? 'active' : ''}`}
            onClick={() => setActiveTab('panel')}
          >
            <i className="fas fa-server"></i> Panel Sync
          </button>
          <button
            className={`add-acct-tab ${activeTab === 'cookie' ? 'active' : ''}`}
            onClick={() => setActiveTab('cookie')}
          >
            <i className="fas fa-cookie-bite"></i> Cookie Import
          </button>
          <button
            className={`add-acct-tab ${activeTab === 'creds' ? 'active' : ''}`}
            onClick={() => setActiveTab('creds')}
          >
            <i className="fas fa-key"></i> Credentials
          </button>
          <button
            className={`add-acct-tab ${activeTab === 'device' ? 'active' : ''}`}
            onClick={() => setActiveTab('device')}
          >
            <i className="fas fa-laptop-code"></i> Device Code
          </button>
          <button
            className={`add-acct-tab ${activeTab === 'json' ? 'active' : ''}`}
            onClick={() => setActiveTab('json')}
          >
            <i className="fas fa-file-import"></i> Import JSON
          </button>

        </div>

        {/* Error / Success */}
        {error && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm whitespace-pre-wrap">
            <strong>Error:</strong> {error}
          </div>
        )}
        {success && (
          <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-xl text-green-700 text-sm">
            <strong>Success:</strong> {success}
          </div>
        )}

        {/* Panel Sync Tab */}
        <div id="tab-panel" className={`add-acct-panel ${activeTab === 'panel' ? '' : 'hidden'}`}>
          <div className="form-group">
            <label className="form-label">Select Panel</label>
            <select
              className="select"
              value={selectedPanelId}
              onChange={(e) => setSelectedPanelId(e.target.value)}
            >
              <option value="">Select a panel...</option>
              {panels.map(p => (
                <option key={p.id} value={p.id}>{p.name} – {p.url}</option>
              ))}
            </select>
            <div className="form-helper">
              Syncs all accounts from the selected panel. Admin accounts get the Admin tag automatically.
            </div>
          </div>

          {previewAccounts.length > 0 && (
            <div className="mt-4 mb-4 p-3 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="text-sm font-medium text-gray-700 mb-2">Accounts to import:</div>
              {previewAccounts.map(acc => (
                <div key={acc.email} className="text-sm text-gray-600 py-1 border-b border-gray-100 last:border-0">
                  <i className="fas fa-user-circle mr-2"></i> {acc.email} – {acc.name}
                </div>
              ))}
            </div>
          )}

          <div className="form-actions">
            <button
              className="form-btn test"
              onClick={handlePreviewAccounts}
              disabled={loading || !selectedPanelId}
            >
              <i className="fas fa-sync"></i> {loading ? 'Loading...' : 'Preview Accounts'}
            </button>
            <button
              className="form-btn save"
              onClick={handleSyncPanel}
              disabled={loading || !selectedPanelId}
            >
              <i className="fas fa-download"></i> Sync Now
            </button>
          </div>
        </div>

        {/* Cookie Import Tab */}
        <div id="tab-cookie" className={`add-acct-panel ${activeTab === 'cookie' ? '' : 'hidden'}`}>
          <div className="form-group">
            <label className="form-label">Email / Username</label>
            <input
              type="text"
              className="form-input"
              placeholder="target@example.com"
              value={cookieEmail}
              onChange={(e) => setCookieEmail(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Cookies (JSON or Netscape format)</label>
            <textarea
              className="form-input"
              rows={4}
              placeholder="Paste cookie data here..."
              value={cookieData}
              onChange={(e) => setCookieData(e.target.value)}
            />
            <div className="form-helper">Supports JSON array or Netscape cookie file format</div>
          </div>
          <button
            className="action-btn secondary"
            style={{ width: '100%', marginBottom: '16px' }}
            onClick={() => void handleCaptureCookies(cookieEmail)}
            disabled={loading}
            title={
              cookieEmail.trim()
                ? 'If this email is already a token account: silent cookie build. Otherwise: Microsoft sign-in until session is ready.'
                : 'Opens Microsoft sign-in; completes when the session is ready'
            }
          >
            <i className="fas fa-globe"></i> Sign in via browser (capture cookies)
          </button>
          <div className="form-helper" style={{ marginBottom: '12px' }}>
            If this mailbox <strong>already exists as a token account</strong>, cookies fill <strong>without a login window</strong>. Otherwise use prefilled Microsoft sign-in (MFA may still apply).
          </div>
          <div className="form-helper" style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: '8px', padding: '10px', color: '#92400e', marginBottom: '16px' }}>
            <i className="fas fa-info-circle"></i> Account will be added with a <strong>Cookie‑Import</strong> system tag.
          </div>
          <div className="form-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button
              className="form-btn save"
              onClick={() => void handleAddViaCookies()}
              disabled={loading || !cookieEmail || !cookieData}
            >
              <i className="fas fa-plus"></i> Save as cookie account
            </button>
            <button
              className="form-btn test"
              onClick={() => void handleConvertCookiesToToken()}
              disabled={loading || !cookieEmail || !cookieData}
              title="Opens OAuth in a window; uses cookies + PKCE to obtain a refresh token"
            >
              <i className="fas fa-exchange-alt"></i> Convert to token
            </button>
            <button className="form-btn cancel" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>

        {/* Credentials Tab */}
        <div id="tab-creds" className={`add-acct-panel ${activeTab === 'creds' ? '' : 'hidden'}`}>
          <div className="form-group">
            <label className="form-label">Email hint (optional)</label>
            <input
              type="text"
              className="form-input"
              placeholder="you@company.com — prefills Microsoft sign-in when not using silent bridge"
              value={credentialEmailHint}
              onChange={(e) => setCredentialEmailHint(e.target.value)}
            />
          </div>
          <button
            className="action-btn primary"
            style={{ width: '100%', marginBottom: '16px' }}
            onClick={() => void handleCaptureCookies(credentialEmailHint)}
            disabled={loading}
            title="Uses token account for this email if present (silent); else opens Microsoft sign-in"
          >
            <i className="fas fa-external-link-alt"></i> Sign in via browser (capture cookies)
          </button>
          <div className="form-helper" style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: '8px', padding: '10px', color: '#92400e', marginBottom: '16px' }}>
            <i className="fas fa-info-circle"></i> Captured cookies appear on the <strong>Cookie Import</strong> tab. Add the <strong>Credential</strong> tag in Accounts if you use this for password-based mailboxes.
          </div>
          <div className="form-actions">
            <button className="form-btn cancel" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>



        {/* Device Code Tab */}
        <div id="tab-device" className={`add-acct-panel ${activeTab === 'device' ? '' : 'hidden'}`}>
          <div className="form-group">
            <label className="form-label">Microsoft OAuth Configuration</label>
            <div className="form-helper" style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '8px', padding: '12px', color: '#1e40af', marginBottom: '16px' }}>
              <i className="fas fa-info-circle"></i> Ensure Microsoft OAuth client ID is configured in Settings → Microsoft OAuth.
            </div>
          </div>

          {deviceCodeError && (
            <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">
              <strong>Error:</strong> {deviceCodeError}
            </div>
          )}
          {deviceCodeSuccess && (
            <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-xl text-green-700 text-sm">
              <strong>Success:</strong> {deviceCodeSuccess}
            </div>
          )}

          {deviceCodeData ? (
            <div className="mt-4 mb-4 p-4 bg-blue-50 border border-blue-200 rounded-xl">
              <h3 className="text-lg font-semibold text-blue-800 mb-2">Device Code Generated</h3>
              <div className="mb-3">
                <div className="text-sm text-blue-700 mb-1">Enter this code:</div>
                <div className="text-2xl font-bold text-blue-900 bg-white p-3 rounded-lg border border-blue-300 text-center">
                  {deviceCodeData.userCode ?? deviceCodeData.user_code}
                </div>
              </div>
              <div className="mb-3">
                <div className="text-sm text-blue-700 mb-1">At this URL:</div>
                <div className="text-lg font-medium text-blue-900 bg-white p-3 rounded-lg border border-blue-300 break-all">
                  {deviceCodeData.verification_uri}
                </div>
              </div>
              <div className="text-sm text-gray-600">
                The code expires in {Math.floor(deviceCodeData.expires_in / 60)} minutes.
                {polling && <span className="block mt-2"><i className="fas fa-spinner fa-spin mr-2"></i> Waiting for authentication...</span>}
              </div>
            </div>
          ) : (
            <div className="mt-4 mb-4 p-4 bg-gray-50 border border-gray-200 rounded-xl">
              <h3 className="text-lg font-semibold text-gray-800 mb-2">Device Code Flow</h3>
              <p className="text-gray-600 mb-4">
                This will open a Microsoft login flow on any device. You'll get a code to enter at a verification URL.
                After authentication, the account will be added with a token.
              </p>
            </div>
          )}

          <div className="form-actions">
            {!deviceCodeData ? (
              <button
                className="form-btn primary"
                onClick={handleStartDeviceCode}
                disabled={loading || polling}
                style={{ background: '#3b82f6', color: '#fff' }}
              >
                <i className="fas fa-play mr-2"></i> Start Device Code Flow
              </button>
            ) : (
              <button
                className="form-btn secondary"
                onClick={() => {
                  setDeviceCodeData(null);
                  setPolling(false);
                }}
                disabled={polling}
              >
                <i className="fas fa-redo mr-2"></i> Start Over
              </button>
            )}
            <button className="form-btn cancel" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      {/* Import JSON Tab */}
      <div id="tab-json" className={`add-acct-panel ${activeTab === 'json' ? '' : 'hidden'}`}>
        <p style={{ marginBottom: '1rem' }}>
          Import token accounts from a JSON file exported from another Watcher instance.
          The file should contain token accounts with refresh tokens.
        </p>
        <div className="form-actions">
          <button
            className="form-btn primary"
            onClick={handleImportJson}
            disabled={loading}
          >
            {loading ? 'Importing...' : 'Select JSON File'}
          </button>
        </div>
      </div>
      </div>
    </div>
  );
};

export default AddAccountModal;