import React, { useState, useEffect } from 'react';
import { getPanels, fetchAccounts } from '../services/panelService';
import { syncPanelAccounts, openOwaExternalBrowserSession } from '../services/accountSyncService';
import { getSettings } from '../services/settingsService';
import { getAccounts } from '../services/accountService';
import { normalizeCookiePasteToHeaderString } from '@shared/cookieFormat';
import { diagnoseMicrosoftAuthError, type MicrosoftAuthDiagnostic } from '@shared/microsoftAuthDiagnostics';
import type { UIAccount } from '../../types/store';

export type AddAccountInitialTab = 'panel' | 'cookie' | 'creds' | 'device' | 'bridge';

interface AddAccountModalProps {
  onSuccess?: () => void;
  onCancel: () => void;
  /** First tab shown when the modal mounts (e.g. open Session Bridge from Dashboard). */
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

  // Session Bridge tab
  const [bridgeAccounts, setBridgeAccounts] = useState<UIAccount[]>([]);
  const [bridgeAccountId, setBridgeAccountId] = useState('');
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [diagPaste, setDiagPaste] = useState('');
  const [diagResult, setDiagResult] = useState<MicrosoftAuthDiagnostic | null>(null);

  // Load panels on mount
  useEffect(() => {
    loadPanels();
  }, []);

  useEffect(() => {
    if (activeTab !== 'bridge') return;
    void (async () => {
      try {
        const all = await getAccounts();
        const tokens = all.filter(a => a.auth?.type === 'token' && a.status === 'active');
        setBridgeAccounts(tokens);
        setBridgeAccountId(prev => {
          if (tokens.some(t => t.id === prev)) return prev;
          return tokens[0]?.id || '';
        });
      } catch {
        setBridgeAccounts([]);
        setBridgeAccountId('');
      }
    })();
  }, [activeTab]);

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

  // Cookie Import: Capture from browser
  const handleCaptureCookies = async () => {
    setLoading(true);
    setError(null);
    try {
      await window.electron.actions.captureCookies('https://login.microsoftonline.com');
      setSuccess('Cookie capture initiated – check browser popup');
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
            `${base}\n\n${ad.title}${ad.aadstsCode ? ` (${ad.aadstsCode})` : ''}\n${ad.detail}\n${ad.suggestions.map(s => `• ${s}`).join('\n')}`
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
            className={`add-acct-tab ${activeTab === 'bridge' ? 'active' : ''}`}
            onClick={() => setActiveTab('bridge')}
          >
            <i className="fas fa-link"></i> Session Bridge
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
            onClick={handleCaptureCookies}
            disabled={loading}
          >
            <i className="fas fa-globe"></i> Capture from Browser (Popup)
          </button>
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
          <button
            className="action-btn primary"
            style={{ width: '100%', marginBottom: '16px' }}
            onClick={handleCaptureCookies}
            disabled={loading}
          >
            <i className="fas fa-external-link-alt"></i> Open Microsoft Login (Capture Cookies)
          </button>
          <div className="form-helper" style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: '8px', padding: '10px', color: '#92400e', marginBottom: '16px' }}>
            <i className="fas fa-info-circle"></i> Opens login.microsoftonline.com in a browser. After you log in, cookies will be captured and an account will be added with a <strong>Credential</strong> system tag.
          </div>
          <div className="form-actions">
            <button className="form-btn cancel" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>

        {/* Session Bridge: official browser OAuth + cookie→token + diagnostics */}
        <div id="tab-bridge" className={`add-acct-panel ${activeTab === 'bridge' ? '' : 'hidden'}`}>
          <div className="form-helper" style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: 12, color: '#1e40af', marginBottom: 16, lineHeight: 1.5 }}>
            <strong>Token → browser OWA:</strong> opens Microsoft&apos;s standard OAuth sign-in in your <strong>default browser</strong> (tenant, client ID, and redirect URI from Settings → Microsoft OAuth). Complete MFA / Conditional Access there.
            <br />
            <strong>Cookie → token:</strong> use <strong>Cookie Import</strong> tab → <em>Convert to token</em> (PKCE; structured errors below).
            <br />
            <strong>Panel → OWA cookies:</strong> on <strong>Accounts</strong>, use <em>Pull OWA cookies from panel</em> if your panel implements{' '}
            <code>{'GET /api/mailbox/{email}/export-cookies'}</code>, then choose <em>In-app OWA: session cookies</em> for that mailbox.
          </div>
          <div className="form-group">
            <label className="form-label">Token account</label>
            <select
              className="form-input"
              value={bridgeAccountId}
              onChange={e => setBridgeAccountId(e.target.value)}
            >
              {bridgeAccounts.length === 0 && <option value="">No active token accounts</option>}
              {bridgeAccounts.map(a => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="action-btn primary"
            style={{ width: '100%', marginBottom: 12 }}
            disabled={bridgeBusy || !bridgeAccountId}
            onClick={() => {
              void (async () => {
                setBridgeBusy(true);
                setError(null);
                setSuccess(null);
                try {
                  await openOwaExternalBrowserSession(bridgeAccountId);
                  setSuccess('Browser opened — sign in with Microsoft. After success, OWA should load in that browser session.');
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBridgeBusy(false);
                }
              })();
            }}
          >
            <i className={`fas ${bridgeBusy ? 'fa-spinner fa-spin' : 'fa-external-link-alt'}`}></i>{' '}
            {bridgeBusy ? 'Opening…' : 'Open OWA sign-in (browser)'}
          </button>

          <div className="form-group">
            <label className="form-label">Diagnose an error message</label>
            <textarea
              className="form-input"
              rows={3}
              placeholder="Paste full error (e.g. invalid_grant, AADSTS50076…)"
              value={diagPaste}
              onChange={e => setDiagPaste(e.target.value)}
            />
            <div className="form-actions" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="form-btn test"
                onClick={() => setDiagResult(diagPaste.trim() ? diagnoseMicrosoftAuthError(diagPaste) : null)}
              >
                <i className="fas fa-stethoscope"></i> Parse
              </button>
            </div>
          </div>
          {diagResult && (
            <div className="mt-2 p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm" style={{ lineHeight: 1.5 }}>
              <div className="font-semibold text-gray-800">{diagResult.title}</div>
              <div className="text-gray-600 mt-1">Category: {diagResult.category}{diagResult.aadstsCode ? ` · ${diagResult.aadstsCode}` : ''}</div>
              <div className="text-gray-700 mt-2">{diagResult.detail}</div>
              <ul className="mt-2 list-disc pl-5 text-gray-700">
                {diagResult.suggestions.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="form-actions" style={{ marginTop: 16 }}>
            <button className="form-btn cancel" onClick={onCancel}>
              Close
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
      </div>
    </div>
  );
};

export default AddAccountModal;