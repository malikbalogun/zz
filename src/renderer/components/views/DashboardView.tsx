import { useState, useEffect, useMemo, useCallback } from 'react';
import { getPanels } from '../../services/panelService';
import { getAccounts } from '../../services/accountService';
import { getMonitoringAlerts } from '../../services/monitoringService';
import { getSettings } from '../../services/settingsService';
import { syncPanelAccounts } from '../../services/accountSyncService';
import type { UIAccount, MonitoringAlert, Settings } from '../../../types/store';
import type { Panel } from '../../../types/panel';

interface DashboardViewProps {
  setActiveView: (view: string) => void;
}

type ActivityRow = {
  id: string;
  ts: number;
  dot: string;
  text: React.ReactNode;
  sub: string;
};

function panelLabelForAccount(accountId: string, accounts: UIAccount[], panels: Panel[]): string {
  const a = accounts.find(x => x.id === accountId);
  if (!a?.panelId) return '';
  return panels.find(p => p.id === a.panelId)?.name || '';
}

function buildActivityRows(
  accounts: UIAccount[],
  panels: Panel[],
  alerts: MonitoringAlert[],
  maxItems: number
): ActivityRow[] {
  const rows: ActivityRow[] = [];

  const sortedAlerts = [...alerts].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  for (const al of sortedAlerts.slice(0, 10)) {
    const acc = accounts.find(x => x.id === al.accountId);
    const email = acc?.email || al.accountId;
    const pn = panelLabelForAccount(al.accountId, accounts, panels);
    rows.push({
      id: `al-${al.id}`,
      ts: new Date(al.timestamp).getTime(),
      dot: '#f59e0b',
      text: (
        <>
          Monitoring alert · <strong>{email}</strong> · matched: {al.matchedKeyword || '—'}
        </>
      ),
      sub: `${new Date(al.timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}${pn ? ` · ${pn}` : ''}${al.subject ? ` · ${al.subject.substring(0, 56)}` : ''}`,
    });
  }

  for (const acc of accounts.filter(a => a.status === 'expired')) {
    const t = acc.lastRefresh || acc.added;
    rows.push({
      id: `ex-${acc.id}`,
      ts: new Date(t).getTime(),
      dot: '#dc2626',
      text: (
        <>
          Account expired / needs re-auth · <strong>{acc.email}</strong>
        </>
      ),
      sub: `${new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}${acc.lastError ? ` · ${acc.lastError.substring(0, 100)}` : ''}`,
    });
  }

  for (const p of panels.filter(x => x.status !== 'connected')) {
    const t = p.lastSync || p.tokenExpiry || new Date().toISOString();
    rows.push({
      id: `poff-${p.id}`,
      ts: new Date(t).getTime(),
      dot: '#6b7280',
      text: (
        <>
          Panel not connected · <strong>{p.name}</strong>
        </>
      ),
      sub: `${p.url} · last sync ${new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`,
    });
  }

  const refreshed = accounts
    .filter(a => a.status === 'active' && a.auth?.type === 'token' && a.lastRefresh)
    .sort(
      (a, b) =>
        new Date(b.lastRefresh!).getTime() - new Date(a.lastRefresh!).getTime()
    )
    .slice(0, 8);

  for (const acc of refreshed) {
    rows.push({
      id: `lr-${acc.id}-${acc.lastRefresh}`,
      ts: new Date(acc.lastRefresh!).getTime(),
      dot: '#8b5cf6',
      text: (
        <>
          Last token refresh · <strong>{acc.email}</strong>
        </>
      ),
      sub: new Date(acc.lastRefresh!).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    });
  }

  rows.sort((a, b) => b.ts - a.ts);
  const seen = new Set<string>();
  const deduped: ActivityRow[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    deduped.push(r);
    if (deduped.length >= maxItems) break;
  }
  return deduped;
}

const DashboardView: React.FC<DashboardViewProps> = ({ setActiveView }) => {
  const [panels, setPanels] = useState<Panel[]>([]);
  const [accounts, setAccounts] = useState<UIAccount[]>([]);
  const [alerts, setAlerts] = useState<MonitoringAlert[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncBusy, setSyncBusy] = useState(false);

  const [toolAccountId, setToolAccountId] = useState('');
  const [compactLayout, setCompactLayout] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 1320 : false
  );

  const loadData = useCallback(async () => {
    try {
      const [panelsData, accountsData, alertsData, settingsData] = await Promise.all([
        getPanels(),
        getAccounts(),
        getMonitoringAlerts(),
        getSettings(),
      ]);
      setPanels(panelsData);
      setAccounts(accountsData);
      setAlerts(alertsData);
      setSettings(settingsData);
    } catch (err) {
      console.error('Failed to load dashboard data', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const onAccountsChanged = () => {
      void loadData();
    };
    window.addEventListener('accounts-changed', onAccountsChanged);
    return () => window.removeEventListener('accounts-changed', onAccountsChanged);
  }, [loadData]);

  useEffect(() => {
    const onResize = () => setCompactLayout(window.innerWidth < 1320);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const maxEvents = settings?.dashboard?.maxEvents ?? 12;

  const activityRows = useMemo(
    () => buildActivityRows(accounts, panels, alerts, maxEvents),
    [accounts, panels, alerts, maxEvents]
  );

  const onlinePanels = panels.filter(p => p.status === 'connected').length;
  const activeAccounts = accounts.filter(a => a.status === 'active').length;
  const expiredAccounts = accounts.filter(a => a.status === 'expired').length;
  const unreadAlerts = alerts.filter(a => !a.read).length;

  const tokenAccountsActive = accounts.filter(
    a => a.auth?.type === 'token' && a.status === 'active'
  ).length;

  const autorefreshTag = settings?.refresh?.tagId || 'autorefresh';
  const withAutorefresh = accounts.filter(
    a => a.status === 'active' && a.tags?.includes(autorefreshTag)
  ).length;
  const activeTokenNoAuto = accounts.filter(
    a =>
      a.status === 'active' &&
      a.auth?.type === 'token' &&
      !a.tags?.includes(autorefreshTag)
  );
  const manualOnlyPreview = activeTokenNoAuto
    .slice(0, 4)
    .map(a => a.email)
    .join(', ');



  const tokenAccounts = useMemo(
    () => accounts.filter(a => a.auth?.type === 'token' && a.status === 'active'),
    [accounts]
  );



  const telegramParts: string[] = [];
  if (settings?.telegram?.monitoring?.enabled) telegramParts.push('Monitoring');
  if (settings?.telegram?.accounts?.enabled) telegramParts.push('Accounts');
  if (settings?.telegram?.search?.enabled) telegramParts.push('Search');
  if (settings?.telegram?.panel?.enabled) telegramParts.push('Panel');
  const telegramSummary =
    telegramParts.length > 0 ? telegramParts.join(', ') : 'None enabled (Settings → Telegram)';

  const refreshSummary = (() => {
    if (!settings?.refresh?.autoRefresh || !settings.refresh.intervalMinutes) {
      return 'Off — refresh tokens manually or per account';
    }
    return `Every ${settings.refresh.intervalMinutes} min · tag “${autorefreshTag}”`;
  })();

  const storageSummary = settings?.storage?.localCredentials
    ? 'Local credentials allowed · tokens in encrypted store'
    : 'Restricted credential storage';

  useEffect(() => {
    if (tokenAccounts.length === 0) {
      if (toolAccountId) setToolAccountId('');
      return;
    }
    if (!toolAccountId || !tokenAccounts.some(a => a.id === toolAccountId)) {
      const adminTagged = tokenAccounts.find(a => a.tags?.includes('admin'));
      setToolAccountId((adminTagged || tokenAccounts[0]).id);
    }
  }, [tokenAccounts, toolAccountId]);

  if (loading) {
    return <div className="db-loading">Loading dashboard...</div>;
  }

  const handleAddPanel = () => {
    setActiveView('panels');
  };

  const handleSyncAll = async () => {
    const connected = panels.filter(p => p.status === 'connected');
    if (connected.length === 0) {
      alert('No connected panels to sync.');
      return;
    }
    setSyncBusy(true);
    try {
      const results: string[] = [];
      for (const panel of connected) {
        try {
          const added = await syncPanelAccounts(panel.id);
          results.push(`${panel.name}: ${added.length} account(s) synced`);
        } catch (e: any) {
          results.push(`${panel.name}: failed — ${e?.message || e}`);
        }
      }
      alert(results.join('\n'));
      await loadData();
      window.dispatchEvent(new CustomEvent('accounts-changed'));
    } finally {
      setSyncBusy(false);
    }
  };

  const handleExportTokens = async () => {
    try {
      const r = await window.electron.actions.exportTokensWithDialog();
      if (!r?.success) {
        if (r?.canceled) return;
        throw new Error(r?.error || 'Export canceled or failed');
      }
      alert(`Exported ${r.count ?? 0} token account(s) to:\n${r.path}`);
    } catch (e: any) {
      alert(`Export failed: ${e?.message || e}`);
    }
  };

  const handleAddAccount = () => {
    setActiveView('accounts');
  };









  const handleViewAllPanels = () => {
    setActiveView('panels');
  };

  const handleViewAlerts = () => {
    setActiveView('monitoring');
  };













  const formatTime = (iso?: string) => {
    if (!iso) return 'Never';
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div id="dashboardView">
      <div className="db-metrics">
        <div className="db-metric">
          <div className="db-metric-left">
            <div className="db-metric-icon" style={{ background: 'linear-gradient(135deg,#3b82f6,#2563eb)' }}>
              <i className="fas fa-server"></i>
            </div>
            <div>
              <div className="db-metric-val">
                {onlinePanels}
                <span className="db-metric-of">/{panels.length}</span>
              </div>
              <div className="db-metric-label">Panels Online</div>
            </div>
          </div>
          <div className="db-metric-status db-status-warn">{panels.length - onlinePanels} offline</div>
        </div>
        <div className="db-metric">
          <div className="db-metric-left">
            <div className="db-metric-icon" style={{ background: 'linear-gradient(135deg,#10b981,#059669)' }}>
              <i className="fas fa-users"></i>
            </div>
            <div>
              <div className="db-metric-val">
                {activeAccounts}
                <span className="db-metric-of">/{accounts.length}</span>
              </div>
              <div className="db-metric-label">Active Accounts</div>
            </div>
          </div>
          <div className="db-metric-status db-status-warn">{expiredAccounts} expired</div>
        </div>
        <div className="db-metric">
          <div className="db-metric-left">
            <div className="db-metric-icon" style={{ background: 'linear-gradient(135deg,#8b5cf6,#7c3aed)' }}>
              <i className="fas fa-key"></i>
            </div>
            <div>
              <div className="db-metric-val">{tokenAccountsActive}</div>
              <div className="db-metric-label">Live token accounts</div>
            </div>
          </div>
          <div className={`db-metric-status ${settings?.refresh?.autoRefresh ? 'db-status-ok' : 'db-status-warn'}`}>
            {settings?.refresh?.autoRefresh ? `auto ${settings.refresh.intervalMinutes}m` : 'manual'}
          </div>
        </div>
        <div className="db-metric" style={{ cursor: 'pointer' }} onClick={handleViewAlerts}>
          <div className="db-metric-left">
            <div className="db-metric-icon" style={{ background: 'linear-gradient(135deg,#f59e0b,#d97706)' }}>
              <i className="fas fa-bell"></i>
            </div>
            <div>
              <div className="db-metric-val">{unreadAlerts}</div>
              <div className="db-metric-label">Unread Alerts</div>
            </div>
          </div>
          <div className="db-metric-status db-status-warn">view →</div>
        </div>
      </div>

      <div
        className="db-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: compactLayout ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(0, 1fr)',
          gap: 20,
          alignItems: 'start',
        }}
      >
        <div className="db-col-left" style={{ minWidth: 0 }}>
          <div className="db-card" style={{ padding: '12px' }}>
            <div className="db-card-header">
              <span className="db-card-title" style={{ fontSize: '14px', fontWeight: '600' }}>
                <i className="fas fa-server" style={{ color: '#3b82f6' }}></i> Panel Status
              </span>
              <button className="mon-header-btn action-btn secondary" onClick={handleViewAllPanels}>
                View All →
              </button>
            </div>
            {panels.length === 0 ? (
              <div style={{ padding: '12px', color: '#9ca3af' }}>No panels added yet.</div>
            ) : (
              panels.map(panel => (
                <div key={panel.id} className="db-panel-row" style={{ marginBottom: '8px' }}>
                  <div
                    className={`db-panel-dot ${panel.status === 'connected' ? 'db-dot-green' : 'db-dot-amber'}`}
                  ></div>
                  <div className="db-panel-info">
                    <div className="db-panel-name">{panel.name}</div>
                    <div className="db-panel-meta">
                      {panel.url} · Synced {formatTime(panel.lastSync)}
                    </div>
                  </div>
                  <div className="db-panel-stat">
                    <span className={`status-pill ${panel.status === 'connected' ? 'active' : 'expired'}`}>
                      {panel.status}
                    </span>
                  </div>
                  <div className="db-panel-stat" style={{ fontSize: '12px', color: '#6b7280' }}>
                    {accounts.filter(a => a.panelId === panel.id).length} accounts
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="db-card" style={{ marginTop: '20px' }}>
            <div className="db-card-header">
              <span className="db-card-title" style={{ fontSize: '14px', fontWeight: '600' }}>
                <i className="fas fa-key" style={{ color: '#8b5cf6' }}></i> Token Health
              </span>
            </div>
            <div className="db-token-row" style={{ marginBottom: '8px' }}>
              <div className="db-token-label">Auto-refresh</div>
              <div className="db-token-val" style={{ color: settings?.refresh?.autoRefresh ? '#10b981' : '#f59e0b' }}>
                {refreshSummary}
              </div>
            </div>
            <div className="db-token-row" style={{ marginBottom: '8px' }}>
              <div className="db-token-label">Active with “{autorefreshTag}” tag</div>
              <div className="db-token-val">
                {withAutorefresh} account{withAutorefresh !== 1 ? 's' : ''}
              </div>
            </div>
            <div className="db-token-row" style={{ marginBottom: '8px' }}>
              <div className="db-token-label">Active token, no autorefresh tag</div>
              <div className="db-token-val" style={{ color: activeTokenNoAuto.length ? '#f59e0b' : '#10b981' }}>
                {activeTokenNoAuto.length
                  ? `${activeTokenNoAuto.length} — ${manualOnlyPreview}${activeTokenNoAuto.length > 4 ? '…' : ''}`
                  : 'None'}
              </div>
            </div>
            <div className="db-token-row" style={{ marginBottom: '8px' }}>
              <div className="db-token-label">Expired / re-auth needed</div>
              <div className="db-token-val" style={{ color: expiredAccounts ? '#dc2626' : '#10b981' }}>
                {expiredAccounts} account{expiredAccounts !== 1 ? 's' : ''}
              </div>
            </div>
            <div className="db-token-row" style={{ marginBottom: '8px' }}>
              <div className="db-token-label">Telegram bots</div>
              <div className="db-token-val" style={{ color: telegramParts.length ? '#10b981' : '#6b7280' }}>
                {telegramSummary}
              </div>
            </div>
            <div className="db-token-row" style={{ marginBottom: '8px' }}>
              <div className="db-token-label">Storage</div>
              <div className="db-token-val" style={{ color: '#10b981' }}>
                {storageSummary}
              </div>
            </div>
          </div>
        </div>

        <div className="db-col-right" style={{ minWidth: 0 }}>
          <div className="db-card" style={{ padding: '12px' }}>
            <div className="db-card-header">
              <span className="db-card-title" style={{ fontSize: '14px', fontWeight: '600' }}>
                <i className="fas fa-history" style={{ color: '#06b6d4' }}></i> Recent Activity
              </span>
            </div>
            <div className="db-activity-feed">
              {activityRows.length === 0 ? (
                <div style={{ padding: '12px', color: '#9ca3af', fontSize: '14px' }}>
                  No activity yet. Monitoring alerts, token refreshes, and panel status appear here as they happen.
                </div>
              ) : (
                activityRows.map(row => (
                  <div className="db-activity-item" key={row.id} style={{ marginBottom: '12px' }}>
                    <div className="db-activity-dot" style={{ background: row.dot }}></div>
                    <div className="db-activity-body">
                      <div className="db-activity-text">{row.text}</div>
                      <div className="db-activity-time">{row.sub}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="db-card" style={{ marginTop: '20px' }}>
            <div className="db-card-header">
              <span className="db-card-title">
                <i className="fas fa-bolt" style={{ color: '#f59e0b' }}></i> Quick Actions
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px', marginTop: '4px' }}>
              <button className="action-btn secondary" style={{ whiteSpace: 'normal', lineHeight: 1.3 }} onClick={handleAddPanel}>
                <i className="fas fa-plus"></i> Add Panel
              </button>
              <button
                className="action-btn secondary"
                style={{ whiteSpace: 'normal', lineHeight: 1.3 }}
                onClick={handleSyncAll}
                disabled={syncBusy}
              >
                <i className="fas fa-sync"></i> {syncBusy ? 'Syncing…' : 'Sync All'}
              </button>
              <button className="action-btn secondary" style={{ whiteSpace: 'normal', lineHeight: 1.3 }} onClick={handleExportTokens}>
                <i className="fas fa-download"></i> Export Tokens
              </button>
              <button className="action-btn secondary" style={{ whiteSpace: 'normal', lineHeight: 1.3 }} onClick={handleAddAccount}>
                <i className="fas fa-user-plus"></i> Add Account
              </button>

            </div>
          </div>

          
        </div>
      </div>
    </div>
  );
};

export default DashboardView;
