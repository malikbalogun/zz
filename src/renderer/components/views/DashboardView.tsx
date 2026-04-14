import { useState, useEffect, useMemo, useCallback } from 'react';
import { getPanels } from '../../services/panelService';
import { getAccounts } from '../../services/accountService';
import { getMonitoringAlerts } from '../../services/monitoringService';
import { getSettings } from '../../services/settingsService';
import {
  syncPanelAccounts,
  openOutlookWeb,
  openPanelAdminDashboard,
  openPanelAuthenticatedPath,
  openOwaExternalBrowserSession,
  pullOwaCookiesFromPanel,
  setOwaMailboxMode,
} from '../../services/accountSyncService';
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
  const [owaToolsBusy, setOwaToolsBusy] = useState(false);
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

  const firstPanelAccount = useMemo(() => {
    const connectedIds = new Set(panels.filter(p => p.status === 'connected').map(p => p.id));
    return accounts.find(a => a.panelId && connectedIds.has(a.panelId));
  }, [accounts, panels]);

  const tokenAccounts = useMemo(
    () => accounts.filter(a => a.auth?.type === 'token' && a.status === 'active'),
    [accounts]
  );

  const selectedToolAccount = useMemo(
    () => tokenAccounts.find(a => a.id === toolAccountId) || null,
    [tokenAccounts, toolAccountId]
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

  const handleOpenSessionBridge = () => {
    window.dispatchEvent(
      new CustomEvent('open-add-account-modal', { detail: { tab: 'bridge' as const } })
    );
  };

  const handleOwaExternalOAuth = async () => {
    const account = resolveToolAccount('OWA browser sign-in');
    if (!account) return;
    try {
      await openOwaExternalBrowserSession(account.id);
    } catch (e: any) {
      handleOpenError(e, account.email);
    }
  };

  const handleDashboardPullOwaCookies = async () => {
    const account = resolveToolAccount('pull OWA cookies from panel');
    if (!account) return;
    if (!account.panelId) {
      alert(
        'This mailbox is not linked to a panel. Sync it from a connected panel in Accounts, then try again.'
      );
      return;
    }
    setOwaToolsBusy(true);
    try {
      await pullOwaCookiesFromPanel(account.id);
      alert(
        'OWA session cookies saved on this account. Use “Use cookies for in-app OWA” below, then “Live Outlook in Watcher” if you want the embedded window to use cookies.'
      );
      await loadData();
    } catch (e: any) {
      handleOpenError(e, account.email);
    } finally {
      setOwaToolsBusy(false);
    }
  };

  const handleDashboardSetOwaMailboxMode = async (mode: 'token' | 'cookie') => {
    const account = resolveToolAccount('in-app OWA mode');
    if (!account) return;
    setOwaToolsBusy(true);
    try {
      await setOwaMailboxMode(account.id, mode);
      await loadData();
    } catch (e: any) {
      alert(e?.message || String(e));
    } finally {
      setOwaToolsBusy(false);
    }
  };

  const handleViewAllPanels = () => {
    setActiveView('panels');
  };

  const handleViewAlerts = () => {
    setActiveView('monitoring');
  };

  const resolveToolAccount = (forAction: string): UIAccount | null => {
    if (selectedToolAccount) return selectedToolAccount;
    alert(
      `No active token mailbox selected for ${forAction}.\n\nOpen Accounts and re-authenticate a mailbox, then select it here.`
    );
    setActiveView('accounts');
    return null;
  };

  const handleOpenError = (error: unknown, accountEmail?: string) => {
    const raw = error instanceof Error ? error.message : String(error);
    if (
      /invalid[_\s-]?grant|invalid refresh token|refresh token has expired|refresh token is invalid/i.test(raw)
    ) {
      alert(
        `Mailbox token expired or invalid for ${accountEmail || 'this account'}.\n\n` +
          `Re-authenticate it in Accounts, then retry.\n\n` +
          `Details: ${raw}`
      );
      setActiveView('accounts');
      return;
    }
    alert(raw);
  };

  const openLiveOutlookBrowser = async () => {
    const account = resolveToolAccount('Outlook (browser)');
    if (!account) return;
    try {
      const u = `https://outlook.office.com/mail/inbox?login_hint=${encodeURIComponent(account.email)}`;
      await window.electron.browser.open(u);
    } catch (e: any) {
      handleOpenError(e, account.email);
    }
  };

  const openOutlookInApp = async () => {
    const account = resolveToolAccount('Outlook in Watcher');
    if (!account) return;
    try {
      await openOutlookWeb(account.id);
    } catch (e: any) {
      handleOpenError(e, account.email);
    }
  };

  const openExchangeAdmin = async () => {
    const account = resolveToolAccount('Exchange Admin');
    if (!account) return;
    try {
      await openPanelAdminDashboard(account.id);
    } catch (e: any) {
      handleOpenError(e, account.email);
    }
  };

  const openPanelConnectors = async () => {
    if (!firstPanelAccount) {
      alert('Connect a panel and link an account to it first.');
      return;
    }
    try {
      await openPanelAuthenticatedPath(firstPanelAccount.id, 'admin/connectors');
    } catch (e: any) {
      alert(
        `${e?.message || e}\n\nIf your server uses a different path, open Panel admin and go to Connectors there.`
      );
    }
  };

  const openPanelSmtp = async () => {
    if (!firstPanelAccount) {
      alert('Connect a panel and link an account to it first.');
      return;
    }
    try {
      await openPanelAuthenticatedPath(firstPanelAccount.id, 'admin/smtp');
    } catch (e: any) {
      alert(
        `${e?.message || e}\n\nIf your server uses a different path, open Panel admin and find SMTP / mail settings there.`
      );
    }
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
          <div className="db-card">
            <div className="db-card-header">
              <span className="db-card-title">
                <i className="fas fa-server" style={{ color: '#3b82f6' }}></i> Panel Status
              </span>
              <button className="mon-header-btn action-btn secondary" onClick={handleViewAllPanels}>
                View All →
              </button>
            </div>
            {panels.length === 0 ? (
              <div style={{ padding: '16px', color: '#9ca3af' }}>No panels added yet.</div>
            ) : (
              panels.map(panel => (
                <div key={panel.id} className="db-panel-row">
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
              <span className="db-card-title">
                <i className="fas fa-key" style={{ color: '#8b5cf6' }}></i> Token Health
              </span>
            </div>
            <div className="db-token-row">
              <div className="db-token-label">Auto-refresh</div>
              <div className="db-token-val" style={{ color: settings?.refresh?.autoRefresh ? '#10b981' : '#f59e0b' }}>
                {refreshSummary}
              </div>
            </div>
            <div className="db-token-row">
              <div className="db-token-label">Active with “{autorefreshTag}” tag</div>
              <div className="db-token-val">
                {withAutorefresh} account{withAutorefresh !== 1 ? 's' : ''}
              </div>
            </div>
            <div className="db-token-row">
              <div className="db-token-label">Active token, no autorefresh tag</div>
              <div className="db-token-val" style={{ color: activeTokenNoAuto.length ? '#f59e0b' : '#10b981' }}>
                {activeTokenNoAuto.length
                  ? `${activeTokenNoAuto.length} — ${manualOnlyPreview}${activeTokenNoAuto.length > 4 ? '…' : ''}`
                  : 'None'}
              </div>
            </div>
            <div className="db-token-row">
              <div className="db-token-label">Expired / re-auth needed</div>
              <div className="db-token-val" style={{ color: expiredAccounts ? '#dc2626' : '#10b981' }}>
                {expiredAccounts} account{expiredAccounts !== 1 ? 's' : ''}
              </div>
            </div>
            <div className="db-token-row">
              <div className="db-token-label">Telegram bots</div>
              <div className="db-token-val" style={{ color: telegramParts.length ? '#10b981' : '#6b7280' }}>
                {telegramSummary}
              </div>
            </div>
            <div className="db-token-row">
              <div className="db-token-label">Storage</div>
              <div className="db-token-val" style={{ color: '#10b981' }}>
                {storageSummary}
              </div>
            </div>
          </div>
        </div>

        <div className="db-col-right" style={{ minWidth: 0 }}>
          <div className="db-card">
            <div className="db-card-header">
              <span className="db-card-title">
                <i className="fas fa-history" style={{ color: '#06b6d4' }}></i> Recent Activity
              </span>
            </div>
            <div className="db-activity-feed">
              {activityRows.length === 0 ? (
                <div style={{ padding: '16px', color: '#9ca3af', fontSize: '14px' }}>
                  No activity yet. Monitoring alerts, token refreshes, and panel status appear here as they happen.
                </div>
              ) : (
                activityRows.map(row => (
                  <div className="db-activity-item" key={row.id}>
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
              <button
                type="button"
                className="action-btn secondary"
                style={{ whiteSpace: 'normal', lineHeight: 1.3 }}
                onClick={handleOpenSessionBridge}
                title="Opens Accounts with Add Account on Session Bridge (browser OAuth, cookie→token, diagnostics)"
              >
                <i className="fas fa-link"></i> Session Bridge
              </button>
            </div>
          </div>

          <div className="db-card" style={{ marginTop: '20px' }}>
            <div className="db-card-header">
              <span className="db-card-title">
                <i className="fas fa-layer-group" style={{ color: '#a855f7' }}></i> Outlook &amp; panel tools
              </span>
            </div>
            <p style={{ fontSize: '13px', color: '#64748b', margin: '0 0 14px', lineHeight: 1.55 }}>
              Choose the mailbox first, then open Outlook or Exchange Admin. Use <strong>OWA sign-in (OAuth)</strong> for the official browser authorization flow (same app registration as the app). If a token is expired, you will be sent to Accounts to re-authenticate. Connectors and SMTP use your panel server (paths may vary — open panel admin if a link 404s).
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <select
                className="inbox-account-select"
                value={toolAccountId}
                onChange={e => setToolAccountId(e.target.value)}
                style={{ minWidth: 240, maxWidth: '100%', flex: '1 1 260px' }}
              >
                {tokenAccounts.length === 0 ? (
                  <option value="">No active token mailbox</option>
                ) : (
                  tokenAccounts.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.email}
                    </option>
                  ))
                )}
              </select>
              <button
                type="button"
                className="action-btn secondary"
                onClick={() => setActiveView('accounts')}
              >
                <i className="fas fa-users"></i> Open Accounts
              </button>
            </div>
            {selectedToolAccount && selectedToolAccount.auth?.type === 'token' && (
              <div
                style={{
                  marginBottom: 12,
                  padding: '10px 12px',
                  background: '#f8fafc',
                  borderRadius: 8,
                  border: '1px solid #e2e8f0',
                }}
              >
                <div style={{ fontSize: 12, color: '#475569', marginBottom: 8, lineHeight: 1.45 }}>
                  <strong>In-app OWA</strong> (Watcher mailbox window) uses{' '}
                  <strong>{selectedToolAccount.auth?.owaMailboxMode === 'cookie' ? 'session cookies' : 'OAuth tokens'}</strong>
                  {selectedToolAccount.auth?.owaCookiesEncrypted ? ' · panel/session cookies saved' : ''}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {selectedToolAccount.panelId ? (
                    <button
                      type="button"
                      className="action-btn secondary"
                      disabled={owaToolsBusy}
                      onClick={() => void handleDashboardPullOwaCookies()}
                      title="Requires panel route GET /api/mailbox/{email}/export-cookies"
                    >
                      <i className="fas fa-cookie-bite"></i> Pull OWA cookies from panel
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="action-btn secondary"
                    disabled={owaToolsBusy || selectedToolAccount.auth?.owaMailboxMode !== 'cookie'}
                    onClick={() => void handleDashboardSetOwaMailboxMode('token')}
                    title="Use refresh-token + MSAL injection in the Watcher OWA window"
                  >
                    <i className="fas fa-key"></i> Use OAuth for in-app OWA
                  </button>
                  <button
                    type="button"
                    className="action-btn secondary"
                    disabled={owaToolsBusy || selectedToolAccount.auth?.owaMailboxMode === 'cookie'}
                    onClick={() => void handleDashboardSetOwaMailboxMode('cookie')}
                    title="Requires cookies from panel or Accounts pull first"
                  >
                    <i className="fas fa-cookie"></i> Use cookies for in-app OWA
                  </button>
                </div>
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <button
                type="button"
                className="action-btn secondary"
                onClick={() => void handleOwaExternalOAuth()}
                disabled={!selectedToolAccount}
                title={
                  selectedToolAccount
                    ? 'Opens Microsoft login in the system browser using this app’s OAuth client (Session Bridge)'
                    : 'Requires an active token account'
                }
              >
                <i className="fas fa-shield-alt"></i> OWA sign-in (OAuth, browser)
              </button>
              <button type="button" className="action-btn secondary" onClick={() => void openLiveOutlookBrowser()}>
                <i className="fas fa-globe"></i> Live Outlook (system browser)
              </button>
              <button
                type="button"
                className="action-btn secondary"
                onClick={() => void openOutlookInApp()}
                disabled={!selectedToolAccount}
                title={!selectedToolAccount ? 'Requires an active token account' : undefined}
              >
                <i className="fas fa-envelope"></i> Live Outlook in Watcher
              </button>
              <button
                type="button"
                className="action-btn secondary"
                onClick={() => void openExchangeAdmin()}
                disabled={!selectedToolAccount}
                title={
                  selectedToolAccount
                    ? 'Opens Microsoft Exchange admin center in your default browser for the selected mailbox'
                    : 'Requires an active token account'
                }
              >
                <i className="fas fa-user-shield"></i> Exchange admin
              </button>
              <button
                type="button"
                className="action-btn secondary"
                onClick={() => void openPanelConnectors()}
                disabled={!firstPanelAccount}
              >
                <i className="fas fa-plug"></i> Connectors
              </button>
              <button
                type="button"
                className="action-btn secondary"
                onClick={() => void openPanelSmtp()}
                disabled={!firstPanelAccount}
              >
                <i className="fas fa-server"></i> SMTP / mail settings (panel)
              </button>
            </div>
            <div
              style={{
                marginTop: 14,
                padding: '12px 14px',
                borderRadius: 10,
                background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.08), rgba(234, 88, 12, 0.06))',
                border: '1px solid rgba(245, 158, 11, 0.25)',
                fontSize: 12,
                color: '#92400e',
                lineHeight: 1.5,
              }}
            >
              <strong style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <i className="fas fa-bolt" style={{ color: '#d97706' }}></i> For best performance
              </strong>
              Keep panels <strong>connected</strong>, run <strong>Sync All</strong> after changes, tag accounts for{' '}
              <strong>autorefresh</strong> in Settings, and close extra mailbox windows when you are done. Bulk-import users from your server on the{' '}
              <span
                role="button"
                tabIndex={0}
                style={{ color: '#b45309', cursor: 'pointer', textDecoration: 'underline', fontWeight: 600 }}
                onClick={() => setActiveView('panels')}
                onKeyDown={e => e.key === 'Enter' && setActiveView('panels')}
              >
                Panels
              </span>{' '}
              view.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DashboardView;
