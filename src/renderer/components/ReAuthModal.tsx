import { useState, useEffect } from 'react';
import type { UIAccount } from '../../types/store';

interface ReAuthModalProps {
  account: UIAccount;
  onCancel: () => void;
  onSuccess?: () => void;
}

const DEFAULT_OFFICE_CLIENT_ID = 'd3590ed6-52b3-4102-aeff-aad2292ab01c';

/**
 * Re-authenticate a token-typed account whose refresh token Microsoft revoked
 * (`requiresReauth: true`). Runs the device-code flow, then calls
 * `accounts.replaceTokenAuth` to swap the new refresh token in-place.
 *
 * Pre-fills the email so the user only enters the device code Microsoft shows.
 */
const ReAuthModal: React.FC<ReAuthModalProps> = ({ account, onCancel, onSuccess }) => {
  const [step, setStep] = useState<'idle' | 'started' | 'polling' | 'done' | 'error'>('idle');
  const [deviceCodeData, setDeviceCodeData] = useState<any>(null);
  const [error, setError] = useState<string>('');
  const [statusMsg, setStatusMsg] = useState<string>('');

  // Auto-start the device-code flow when the modal opens.
  useEffect(() => {
    void handleStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStart = async () => {
    setError('');
    setStatusMsg('Requesting a device code from Microsoft…');
    try {
      const result = await window.electron.microsoft.startDeviceCode();
      if (!result.success) throw new Error(result.error || 'startDeviceCode failed');
      setDeviceCodeData(result);
      setStep('started');
      setStatusMsg('Open the verification URL and enter the code below.');
      // Start polling
      setStep('polling');
      void poll(result);
    } catch (err: any) {
      setError(err?.message || String(err));
      setStep('error');
    }
  };

  const poll = async (data: any) => {
    const dc = data?.deviceCode ?? data?.device_code;
    if (!dc) {
      setError('Missing device code from start response');
      setStep('error');
      return;
    }
    const intervalSec = data.interval ?? 5;
    try {
      const result: any = await window.electron.microsoft.pollDeviceCode(
        dc,
        DEFAULT_OFFICE_CLIENT_ID,
        'common'
      );
      if (result.success && result.refreshToken) {
        setStatusMsg('Microsoft accepted the code. Updating account…');
        await window.electron.accounts.replaceTokenAuth(
          account.id,
          result.refreshToken,
          'common',
          DEFAULT_OFFICE_CLIENT_ID,
          'https://outlook.office.com',
          'ews'
        );
        setStep('done');
        setStatusMsg('Account re-authenticated. You can close this dialog.');
        onSuccess?.();
        return;
      }
      if (result.pending) {
        setTimeout(() => void poll(data), intervalSec * 1000);
        return;
      }
      if (result.slowDown) {
        setTimeout(() => void poll(data), intervalSec * 2000);
        return;
      }
      if (result.expired) {
        setError('Device code expired. Click "Start over" to try again.');
        setStep('error');
        return;
      }
      setError(result.error || 'Polling failed');
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
      <div className="modal-content" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 className="modal-title" style={{ marginBottom: 0 }}>
            <i className="fas fa-sign-in-alt" style={{ marginRight: 8, color: '#3b82f6' }} />
            Sign in again
          </h2>
          <button className="icon-btn" onClick={onCancel}>
            <i className="fas fa-times" />
          </button>
        </div>

        <p style={{ marginBottom: 12, color: '#374151' }}>
          Microsoft revoked the refresh token for <strong>{account.email}</strong>. Sign in again to
          restore access. We'll swap the new token into the existing account so all your tags,
          monitoring rules, and history stay intact.
        </p>

        {step === 'idle' && (
          <div style={{ padding: 16, background: '#f9fafb', borderRadius: 8 }}>
            <i className="fas fa-spinner fa-spin" style={{ marginRight: 8 }} />
            Starting…
          </div>
        )}

        {(step === 'started' || step === 'polling') && deviceCodeData && (
          <div style={{ padding: 16, background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8 }}>
            <div style={{ marginBottom: 12 }}>
              <strong>Step 1.</strong> Open this URL in your browser:
              <div style={{ marginTop: 6 }}>
                <button
                  type="button"
                  className="action-btn primary"
                  onClick={() => void window.electron.browser.open(verificationUri)}
                >
                  <i className="fas fa-external-link-alt" style={{ marginRight: 6 }} />
                  Open {verificationUri}
                </button>
              </div>
            </div>
            <div style={{ marginBottom: 8 }}>
              <strong>Step 2.</strong> Enter this code:
              <div
                style={{
                  marginTop: 8,
                  padding: 16,
                  background: 'white',
                  border: '1px dashed #94a3b8',
                  borderRadius: 8,
                  textAlign: 'center',
                  fontFamily: 'monospace',
                  fontSize: 28,
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
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, textAlign: 'center' }}>
                Click the code to copy it.
              </div>
            </div>
            <div style={{ marginTop: 12, fontSize: 13, color: '#374151' }}>
              <i className="fas fa-spinner fa-spin" style={{ marginRight: 6 }} />
              Waiting for sign-in…
            </div>
          </div>
        )}

        {step === 'done' && (
          <div style={{ padding: 16, background: '#ecfdf5', border: '1px solid #6ee7b7', borderRadius: 8 }}>
            <i className="fas fa-check-circle" style={{ color: '#059669', marginRight: 8 }} />
            {statusMsg}
          </div>
        )}

        {step === 'error' && (
          <div style={{ padding: 16, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8 }}>
            <div style={{ color: '#dc2626', marginBottom: 8 }}>
              <i className="fas fa-exclamation-triangle" style={{ marginRight: 8 }} />
              {error || 'Something went wrong'}
            </div>
            <button type="button" className="action-btn secondary" onClick={() => void handleStart()}>
              Start over
            </button>
          </div>
        )}

        {statusMsg && step !== 'done' && step !== 'error' && (
          <div style={{ marginTop: 12, fontSize: 12, color: '#6b7280' }}>{statusMsg}</div>
        )}

        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="action-btn secondary" onClick={onCancel}>
            {step === 'done' ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ReAuthModal;
