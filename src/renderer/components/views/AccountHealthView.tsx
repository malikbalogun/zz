import { useState, useEffect, useCallback, useMemo } from 'react';
import type { UIAccount } from '../../../types/store';
import { getAccounts, runTokenHealthCheckForAll, runTokenHealthCheckForOne } from '../../services/accountService';
import { getSettings } from '../../services/settingsService';

const AccountHealthView: React.FC = () => {
  const [accounts, setAccounts] = useState<UIAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkingOne, setCheckingOne] = useState<string | null>(null);
  const [refreshIntervalMinutes, setRefreshIntervalMinutes] = useState(0);

  const load = useCallback(async () => {
    setAccounts(await getAccounts());
    try {
      const s = await getSettings();
      setRefreshIntervalMinutes(s.refresh?.autoRefresh ? Number(s.refresh.intervalMinutes || 0) : 0);
    } catch {
      setRefreshIntervalMinutes(0);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await runTokenHealthCheckForAll();
      } catch (e) {
        console.warn('Token health check:', e);
      }
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const handleRecheck = async () => {
    setChecking(true);
    try {
      await runTokenHealthCheckForAll();
      await load();
    } finally {
      setChecking(false);
    }
  };

  const handleRecheckOne = async (accountId: string) => {
    setCheckingOne(accountId);
    try {
      await runTokenHealthCheckForOne(accountId);
      await load();
    } finally {
      setCheckingOne(null);
    }
  };

  const active = accounts.filter(a => a.status === 'active').length;
  const expired = accounts.filter(a => a.status === 'expired').length;
  const errored = accounts.filter(a => a.status === 'error').length;
  const tokenAccounts = accounts.filter(a => a.auth?.type === 'token');
  const sortedAccounts = useMemo(
    () =>
      [...accounts].sort((a, b) => {
        const rank = (s: UIAccount['status']) => (s === 'error' ? 0 : s === 'expired' ? 1 : 2);
        const r = rank(a.status) - rank(b.status);
        if (r !== 0) return r;
        return (a.email || '').localeCompare(b.email || '');
      }),
    [accounts]
  );

  const minutesSince = (iso?: string) => {
    if (!iso) return 'never';
    const d = Date.now() - new Date(iso).getTime();
    const m = Math.max(0, Math.floor(d / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ${m % 60}m ago`;
  };

  if (loading && accounts.length === 0) return <div className="db-loading">Loading account health...</div>;

  return (
    <div className="feature-shell">
      <div className="feature-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <h2>Account Health</h2>
        <button type="button" className="action-btn primary" onClick={handleRecheck} disabled={checking}>
          <i className={`fas ${checking ? 'fa-spinner fa-spin' : 'fa-sync-alt'}`}></i>{' '}
          {checking ? 'Verifying tokens…' : 'Refresh token status'}
        </button>
      </div>
      <p className="feature-muted" style={{ marginBottom: 16, maxWidth: 720 }}>
        Status is updated by calling Microsoft with each stored refresh token. If you revoke access in Azure or M365, the next check marks the account <strong>expired</strong> or <strong>error</strong>.
      </p>
      <p className="feature-muted" style={{ marginBottom: 10 }}>
        Auto refresh: {refreshIntervalMinutes > 0 ? `every ${refreshIntervalMinutes} minute(s)` : 'disabled/manual only'}.
      </p>
      <div className="feature-kpis">
        <div className="feature-kpi"><strong>{accounts.length}</strong><span>Total Accounts</span></div>
        <div className="feature-kpi"><strong>{active}</strong><span>Active</span></div>
        <div className="feature-kpi"><strong>{expired}</strong><span>Expired</span></div>
        <div className="feature-kpi"><strong>{errored}</strong><span>Error</span></div>
      </div>
      <div className="feature-card">
        <div className="feature-card-title">Connection &amp; Token Status</div>
        {accounts.length === 0 && <div className="feature-muted" style={{ padding: '16px 0' }}>No accounts added.</div>}
        {sortedAccounts.map(a => (
          <div className="feature-row" key={a.id}>
            <div style={{ flex: 1 }}>
              <strong>{a.email}</strong>
              <div className="feature-muted">
                Auth: {a.auth?.type || 'none'} · Added: {new Date(a.added).toLocaleDateString()}
                {a.lastRefresh ? ` · Last check: ${new Date(a.lastRefresh).toLocaleString()} (${minutesSince(a.lastRefresh)})` : ''}
              </div>
              {a.lastError ? (
                <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>{a.lastError}</div>
              ) : null}
            </div>
            {a.auth?.type === 'token' && (
              <button
                type="button"
                className="action-btn secondary"
                style={{ marginRight: 8, padding: '6px 10px', fontSize: 12 }}
                onClick={() => void handleRecheckOne(a.id)}
                disabled={checkingOne === a.id || checking}
                title="Re-check only this account token"
              >
                <i className={`fas ${checkingOne === a.id ? 'fa-spinner fa-spin' : 'fa-redo'}`}></i>
              </button>
            )}
            <span
              className={`status-pill ${
                a.status === 'active' ? 'active' : a.status === 'error' ? 'error' : 'expired'
              }`}
            >
              {a.status}
            </span>
          </div>
        ))}
      </div>
      {tokenAccounts.length > 0 && (
        <div className="feature-card" style={{ marginTop: 12 }}>
          <div className="feature-card-title">Token Details</div>
          {tokenAccounts.map(a => {
            const auth = a.auth as { type: 'token'; clientId?: string; authorityEndpoint?: string; scopeType?: string };
            return (
              <div className="feature-row" key={a.id}>
                <div style={{ flex: 1 }}>
                  <strong>{a.email}</strong>
                  <div className="feature-muted">
                    Client: {auth.clientId?.substring(0, 12) || 'n/a'}... · Scope: {auth.scopeType || 'ews'} · Authority:{' '}
                    {auth.authorityEndpoint?.substring(0, 30) || 'n/a'}...
                  </div>
                </div>
                <span className={`status-pill ${a.status === 'active' ? 'active' : 'expired'}`}>{a.status}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default AccountHealthView;
