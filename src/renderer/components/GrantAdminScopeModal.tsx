import { useState, useEffect } from 'react';
import type { UIAccount } from '../../types/store';

interface GrantAdminScopeModalProps {
  account: UIAccount;
  onCancel: () => void;
  onSuccess?: () => void;
}

const DEFAULT_OFFICE_CLIENT_ID = 'd3590ed6-52b3-4102-aeff-aad2292ab01c';

/**
 * Run the device-code flow with Microsoft Graph admin scopes
 * (Directory.Read.All + User.Read.All) and store the resulting refresh
 * token under `account.auth.adminGraphRefreshToken` so the harvest UI
 * can later list every user in the tenant.
 *
 * Requires a global admin to consent; non-admin sign-ins fail at the
 * consent screen and we surface the AAD error verbatim.
 */
const GrantAdminScopeModal: React.FC<GrantAdminScopeModalProps> = ({ account, onCancel, onSuccess }) => {
  const [step, setStep] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [deviceCodeData, setDeviceCodeData] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    setError('');
    try {
      const result = await window.electron.oauth.deviceCodeAdminScope();
      if (!result?.success) throw new Error(result?.error || 'deviceCodeAdminScope failed');
      setDeviceCodeData(result);
      setStep('pending');
      void poll(result);
    } catch (err: any) {
      setError(err?.message || String(err));
      setStep('error');
    }
  };

  const poll = async (data: any) => {
    const dc = data?.deviceCode ?? data?.device_code;
    const intervalSec = data?.interval ?? 5;
    if (!dc) {
      setError('Missing device code');
      setStep('error');
      return;
    }
    try {
      const result: any = await window.electron.oauth.pollToken(dc, DEFAULT_OFFICE_CLIENT_ID, 'common');
      if (result?.success && result?.refreshToken) {
        // Store under account.auth.adminGraphRefreshToken via store.set on the
        // accounts array. We go through the existing accounts service so the
        // change emits the accounts-changed event.
        const accountsRaw = (await window.electron.store.get('accounts')) || [];
        const accounts = Array.isArray(accountsRaw) ? accountsRaw : [];
        const idx = accounts.findIndex((a: any) => a.id === account.id);
        if (idx === -1) throw new Error('Admin account vanished from store');
        const target = accounts[idx];
        if (target.auth?.type !== 'token') {
          throw new Error('Admin Graph access can only be attached to token-typed accounts.');
        }
        target.auth = { ...target.auth, adminGraphRefreshToken: result.refreshToken };
        accounts[idx] = target;
        await window.electron.store.set('accounts', accounts);
        window.dispatchEvent(new CustomEvent('accounts-changed'));
        setStep('done');
        onSuccess?.();
        return;
      }
      if (result?.pending) {
        setTimeout(() => void poll(data), intervalSec * 1000);
        return;
      }
      if (result?.slowDown) {
        setTimeout(() => void poll(data), intervalSec * 2000);
        return;
      }
      if (result?.expired) {
        setError('Device code expired. Click "Start over" to try again.');
        setStep('error');
        return;
      }
      setError(result?.error || 'Polling failed');
      setStep('error');
    } catch (err: any) {
      setError(err?.message || String(err));
      setStep('error');
    }
  };

  const code = deviceCodeData?.userCode ?? deviceCodeData?.user_code ?? '';
  const verificationUri =
    deviceCodeData?.verificationUri ?? deviceCodeData?.verification_uri ?? 'https://microsoft.com/devicelogin';

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 className="modal-title" style={{ marginBottom: 0 }}>
            <i className="fas fa-shield-alt" style={{ marginRight: 8, color: '#7c3aed' }} />
            Grant admin Graph access
          </h2>
          <button className="icon-btn" onClick={onCancel}>
            <i className="fas fa-times" />
          </button>
        </div>

        <p style={{ color: '#374151', marginBottom: 12 }}>
          This grants <strong>{account.email}</strong> the Microsoft Graph scopes
          <code style={{ background: '#f3f4f6', padding: '2px 6px', margin: '0 4px', borderRadius: 4 }}>Directory.Read.All</code>
          and
          <code style={{ background: '#f3f4f6', padding: '2px 6px', margin: '0 4px', borderRadius: 4 }}>User.Read.All</code>.
          Once consented, "View Other Associated Accounts → via Graph" will list every user in the
          tenant and add them with the <code>child-of:{account.email}</code> tag.
        </p>
        <div style={{ padding: 10, background: '#fef3c7', border: '1px solid #fbbf24', borderRadius: 6, marginBottom: 12, fontSize: 13, color: '#78350f' }}>
          <i className="fas fa-info-circle" style={{ marginRight: 6 }} />
          A global administrator must approve the consent prompt. Non-admins will see an "admin
          approval required" error from Microsoft.
        </div>

        {step === 'pending' && deviceCodeData && (
          <div style={{ padding: 14, background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8 }}>
            <div style={{ marginBottom: 10 }}>
              <strong>Step 1.</strong>{' '}
              <button
                type="button"
                className="action-btn primary"
                onClick={() => void window.electron.browser.open(verificationUri)}
              >
                <i className="fas fa-external-link-alt" style={{ marginRight: 6 }} />
                Open {verificationUri}
              </button>
            </div>
            <div style={{ marginBottom: 6 }}>
              <strong>Step 2.</strong> Enter this code (sign in as a global admin):
            </div>
            <div
              style={{
                padding: 14,
                background: 'white',
                border: '1px dashed #94a3b8',
                borderRadius: 8,
                textAlign: 'center',
                fontFamily: 'monospace',
                fontSize: 26,
                letterSpacing: 4,
                fontWeight: 700,
                cursor: 'pointer',
              }}
              title="Click to copy"
              onClick={() => {
                void navigator.clipboard?.writeText(code);
              }}
            >
              {code}
            </div>
            <div style={{ marginTop: 10, fontSize: 13, color: '#374151' }}>
              <i className="fas fa-spinner fa-spin" style={{ marginRight: 6 }} />
              Waiting for consent…
            </div>
          </div>
        )}

        {step === 'done' && (
          <div style={{ padding: 14, background: '#ecfdf5', border: '1px solid #6ee7b7', borderRadius: 8 }}>
            <i className="fas fa-check-circle" style={{ color: '#059669', marginRight: 6 }} />
            Admin Graph access granted. You can now use "View Other Associated Accounts → via Graph".
          </div>
        )}

        {step === 'error' && (
          <div style={{ padding: 14, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8 }}>
            <div style={{ color: '#dc2626', marginBottom: 8 }}>
              <i className="fas fa-exclamation-triangle" style={{ marginRight: 6 }} />
              {error}
            </div>
            <button type="button" className="action-btn secondary" onClick={() => void start()}>
              Start over
            </button>
          </div>
        )}

        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="action-btn secondary" onClick={onCancel}>
            {step === 'done' ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default GrantAdminScopeModal;
