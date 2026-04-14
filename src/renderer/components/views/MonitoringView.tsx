import { useState, useEffect } from 'react';
import { getMonitoringRules, addMonitoringRule, updateMonitoringRule, deleteMonitoringRule, toggleMonitoringRule } from '../../services/monitoringService';
import { getMonitoringAlerts, deleteAlert, markAllAlertsRead, clearAlerts } from '../../services/monitoringService';
import { getAccounts } from '../../services/accountService';
import { getPanels } from '../../services/panelService';
import { openPanelAdminDashboard } from '../../services/accountSyncService';
import { OutlookService } from '../../services/outlookService';
import type { OutlookFolder } from '../../services/outlookService';

const MonitoringView = () => {
  const [rules, setRules] = useState<any[]>([]);
  const [alerts, setAlerts] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [panels, setPanels] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    accountId: '',
    foldersInput: 'Inbox',
    keywordsInput: '',
    senderScope: 'all' as 'all' | 'specific',
    senderAddressesInput: '',
  });
  const [pauseAllLabel, setPauseAllLabel] = useState<'Pause All' | 'Resume All'>('Pause All');
  const [folderOptions, setFolderOptions] = useState<OutlookFolder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);

  // Load data on mount
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [rulesData, alertsData, accountsData, panelsData] = await Promise.all([
        getMonitoringRules(),
        getMonitoringAlerts(),
        getAccounts(),
        getPanels(),
      ]);
      setRules(rulesData);
      setAlerts(alertsData);
      setAccounts(accountsData);
      setPanels(panelsData);
      // Determine pause/resume all label
      const activeCount = rulesData.filter(r => r.status === 'active').length;
      setPauseAllLabel(activeCount > 0 ? 'Pause All' : 'Resume All');
    } catch (error) {
      console.error('Failed to load monitoring data:', error);
    } finally {
      setLoading(false);
    }
  };

  // Add a new monitoring rule
  const handleAddRule = async () => {
    const { accountId, foldersInput, keywordsInput, senderScope, senderAddressesInput } = formData;
    if (!accountId || keywordsInput.trim() === '') {
      alert('Please select an account and add at least one keyword');
      return;
    }
    if (senderScope === 'specific' && !senderAddressesInput.trim()) {
      alert('Add at least one sender email/domain, or choose “All senders”.');
      return;
    }
    setLoading(true);
    try {
      await addMonitoringRule({
        accountId,
        folders: foldersInput.split(',').map(f => f.trim()).filter(f => f),
        keywords: keywordsInput.split(',').map(k => k.trim()).filter(k => k),
        tags: [],
        status: 'active',
        timeScope: 'live',
        senderScope,
        senderAddresses:
          senderScope === 'specific'
            ? senderAddressesInput.split(',').map(s => s.trim()).filter(Boolean)
            : [],
      });
      setFormData({
        accountId: '',
        foldersInput: 'Inbox',
        keywordsInput: '',
        senderScope: 'all',
        senderAddressesInput: '',
      });
      await loadData();
    } catch (error) {
      alert(`Failed to add monitoring rule: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!formData.accountId) {
      setFolderOptions([]);
      return;
    }
    const acc = accounts.find(a => a.id === formData.accountId);
    if (!acc || acc.auth?.type !== 'token') {
      setFolderOptions([]);
      return;
    }
    setFoldersLoading(true);
    OutlookService.listFolders(acc)
      .then(setFolderOptions)
      .catch(() => setFolderOptions([]))
      .finally(() => setFoldersLoading(false));
  }, [formData.accountId, accounts]);

  // Reset form
  const handleResetForm = () => {
    setFormData({
      accountId: '',
      foldersInput: 'Inbox',
      keywordsInput: '',
      senderScope: 'all',
      senderAddressesInput: '',
    });
  };

  // Toggle rule active/paused
  const handleToggleRule = async (ruleId: string) => {
    setLoading(true);
    try {
      await toggleMonitoringRule(ruleId);
      await loadData();
    } catch (error) {
      alert(`Failed to toggle rule: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  // Delete rule
  const handleDeleteRule = async (ruleId: string) => {
    if (!confirm('Delete this monitoring rule?')) return;
    setLoading(true);
    try {
      await deleteMonitoringRule(ruleId);
      await loadData();
    } catch (error) {
      alert(`Failed to delete rule: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  // Pause / Resume all rules
  const handlePauseResumeAll = async () => {
    setLoading(true);
    try {
      const targetStatus = pauseAllLabel === 'Pause All' ? 'paused' : 'active';
      for (const rule of rules) {
        await updateMonitoringRule(rule.id, { status: targetStatus });
      }
      await loadData();
    } catch (error) {
      alert(`Failed to ${pauseAllLabel.toLowerCase()}: ${error}`);
    } finally {
      setLoading(false);
    }
  };



  // Delete alert
  const handleDeleteAlert = async (alertId: string) => {
    if (!confirm('Dismiss this alert?')) return;
    setLoading(true);
    try {
      await deleteAlert(alertId);
      await loadData();
    } catch (error) {
      alert(`Failed to dismiss alert: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  // Mark all alerts read
  const handleMarkAllRead = async () => {
    setLoading(true);
    try {
      await markAllAlertsRead();
      await loadData();
    } catch (error) {
      alert(`Failed to mark all read: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteAllAlerts = async () => {
    if (!confirm(`Delete all ${alerts.length} monitoring alert(s)? This cannot be undone.`)) return;
    setLoading(true);
    try {
      await clearAlerts();
      await loadData();
    } catch (error) {
      alert(`Failed to delete alerts: ${error}`);
    } finally {
      setLoading(false);
    }
  };



  // Get panel name for account
  const getPanelForAccount = (accountId: string) => {
    const account = accounts.find(a => a.id === accountId);
    if (!account?.panelId) return null;
    const panel = panels.find(p => p.id === account.panelId);
    return panel;
  };



  // Format time for alerts
  const formatAlertTime = (iso: string) => {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    if (date.getDate() === now.getDate() - 1) return 'Yesterday';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  // Get avatar initials
  const getAvatar = (email: string) => {
    const parts = email.split('@')[0].split('.');
    return parts.map(p => p[0]).join('').toUpperCase().substring(0, 2);
  };

  // Determine scenario type for alert
  const getScenarioType = (alert: any) => {
    const rule = rules.find(r => r.id === alert.ruleId);
    if (!rule) return 'keyword';
    return rule.scenarioType || 'keyword';
  };

  // Get scenario badge label and class
  const getScenarioBadge = (type: string) => {
    switch (type) {
      case 'keyword': return { label: 'Keyword', cls: 'alert-type-keyword' };
      case 'folder': return { label: 'Folder', cls: 'alert-type-folder' };
      case 'keyword-in-folder': return { label: 'Keyword in Folder', cls: 'alert-type-kwfolder' };
      case 'token': return { label: 'Token', cls: 'alert-type-token' };
      default: return { label: 'Keyword', cls: 'alert-type-keyword' };
    }
  };

  // Group accounts by panel
  const accountsByPanel: Record<string, any[]> = {};
  const accountsWithoutPanel: any[] = [];
  
  accounts.forEach(account => {
    const panel = getPanelForAccount(account.id);
    if (panel) {
      if (!accountsByPanel[panel.id]) {
        accountsByPanel[panel.id] = [];
      }
      accountsByPanel[panel.id].push(account);
    } else {
      accountsWithoutPanel.push(account);
    }
  });

  // Unread alerts count
  const unreadAlerts = alerts.filter(a => !a.read).length;

  if (loading && rules.length === 0 && alerts.length === 0) {
    return <div id="monitoringView">Loading monitoring data...</div>;
  }

  return (
    <div id="monitoringView">
      {/* ADD MONITORING ACCOUNT FORM */}
      <div className="monitoring-card">
        <div className="monitoring-card-header">
          <div className="monitoring-card-title">
            <i className="fas fa-user-plus" style={{ color: '#3b82f6' }}></i> Add Monitoring Account
          </div>
          <button className="action-btn secondary mon-header-btn" onClick={handleResetForm} disabled={loading}>
            <i className="fas fa-undo"></i> Reset
          </button>
        </div>
        <div className="monitoring-card-body padded">
          <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start' }}>
            {/* Left column: Account selection */}
            <div style={{ flex: 1 }}>
              <div className="form-group">
                <label className="form-label">Select Account</label>
                <select
                  className="select"
                  style={{ width: '100%' }}
                  value={formData.accountId}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      accountId: e.target.value,
                      foldersInput: 'Inbox',
                    })
                  }
                >
                  <option value="">Select an account...</option>
                  {Object.entries(accountsByPanel).map(([panelId, panelAccounts]) => {
                    const panel = panels.find(p => p.id === panelId);
                    return (
                      <optgroup key={panelId} label={`Panel: ${panel?.name || panelId}`}>
                        {panelAccounts.map(acc => (
                          <option key={acc.id} value={acc.id}>{acc.email}</option>
                        ))}
                      </optgroup>
                    );
                  })}
                  {accountsWithoutPanel.length > 0 && (
                    <optgroup label="No Panel">
                      {accountsWithoutPanel.map(acc => (
                        <option key={acc.id} value={acc.id}>{acc.email}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <div className="form-helper">
                  Don't see an account?{' '}
                  <a href="#" onClick={() => alert('Navigate to Accounts view first')} style={{ color: '#3b82f6' }}>
                    Add it first →
                  </a>
                </div>
              </div>
            </div>

            {/* Right column: Monitoring settings */}
            <div style={{ flex: 1, borderLeft: '1px solid #e5e7eb', paddingLeft: '24px' }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#374151', marginBottom: '16px' }}>
                <i className="fas fa-cog"></i> Monitoring Settings
              </div>
              <div className="form-group">
                <label className="form-label">Folders to monitor</label>
                {foldersLoading ? (
                  <div className="form-helper" style={{ padding: '12px 0' }}>
                    <i className="fas fa-spinner fa-spin" /> Loading folders…
                  </div>
                ) : folderOptions.length > 0 ? (
                  <>
                    <select
                      multiple
                      className="select"
                      style={{ width: '100%', minHeight: 120 }}
                      value={formData.foldersInput.split(',').map(s => s.trim()).filter(Boolean)}
                      onChange={(e) => {
                        const selected = Array.from(e.target.selectedOptions, o => o.value);
                        setFormData({
                          ...formData,
                          foldersInput: selected.length > 0 ? selected.join(', ') : 'Inbox',
                        });
                      }}
                    >
                      {folderOptions.map(f => (
                        <option key={f.id} value={f.displayName}>
                          {f.displayName}
                        </option>
                      ))}
                    </select>
                    <div className="form-helper">
                      Ctrl/Cmd+click to select multiple (same names as in Central Inbox).
                    </div>
                  </>
                ) : (
                  <>
                    <input
                      type="text"
                      className="form-input"
                      placeholder="Inbox, Sent, Drafts"
                      value={formData.foldersInput}
                      onChange={(e) => setFormData({ ...formData, foldersInput: e.target.value })}
                    />
                    <div className="form-helper">Comma-separated folder names (picker unavailable for this account).</div>
                  </>
                )}
              </div>
              <div className="form-group">
                <label className="form-label">Keywords for alerts</label>
                <textarea
                  className="form-input"
                  rows={3}
                  placeholder="urgent, invoice, payment, password reset..."
                  value={formData.keywordsInput}
                  onChange={(e) => setFormData({ ...formData, keywordsInput: e.target.value })}
                />
                <div className="form-helper">Any keyword match in subject/body triggers an alert</div>
              </div>
              <div className="form-helper" style={{ marginBottom: '12px', padding: '10px 12px', background: '#f0f9ff', borderRadius: '8px', border: '1px solid #bae6fd', color: '#0c4a6e', fontSize: '13px' }}>
                <strong>Future mail only.</strong> Alerts fire for new messages received after this rule starts.
                To search older mail, use <strong>Account Search</strong> with keywords and date range.
              </div>
              <div className="form-group">
                <label className="form-label">Senders</label>
                <select
                  className="select"
                  style={{ width: '100%' }}
                  value={formData.senderScope}
                  onChange={(e) =>
                    setFormData({ ...formData, senderScope: e.target.value as 'all' | 'specific' })
                  }
                >
                  <option value="all">All senders</option>
                  <option value="specific">Only listed senders / domains</option>
                </select>
              </div>
              {formData.senderScope === 'specific' && (
                <div className="form-group">
                  <label className="form-label">Sender addresses</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="billing@acme.com, @vendor.com"
                    value={formData.senderAddressesInput}
                    onChange={(e) => setFormData({ ...formData, senderAddressesInput: e.target.value })}
                  />
                  <div className="form-helper">Comma-separated; partial match on From address</div>
                </div>
              )}
            </div>
          </div>
          <button
            className="action-btn primary mon-submit-btn"
            onClick={handleAddRule}
            disabled={loading}
          >
            <i className="fas fa-plus-circle"></i> Add &amp; Start Monitoring
          </button>
        </div>
      </div>

      {/* ACTIVE LISTENERS */}
      <div className="monitoring-card" style={{ marginTop: '24px' }}>
        <div className="monitoring-card-header">
          <div className="monitoring-card-title">
            <i className="fas fa-broadcast-tower" style={{ color: '#10b981' }}></i> Monitored Accounts
            <span className="badge" style={{ background: '#10b981', marginLeft: '4px' }}>{rules.length}</span>
          </div>
          <button
            className="action-btn secondary mon-header-btn"
            onClick={handlePauseResumeAll}
            disabled={loading}
          >
            <i className={`fas fa-${pauseAllLabel === 'Pause All' ? 'pause' : 'play'}`}></i> {pauseAllLabel}
          </button>
        </div>
        <div className="monitoring-card-body padded">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {rules.length === 0 ? (
              <div style={{ textAlign: 'center', color: '#9ca3af', padding: '20px' }}>
                No active listeners. Add one above.
              </div>
            ) : (
              rules.map(rule => {
                const account = accounts.find(a => a.id === rule.accountId);
                const panel = getPanelForAccount(rule.accountId);
                const isAdmin = account?.tags?.includes('admin');
                return (
                  <div className="listener-row" key={rule.id}>
                    <div className="listener-avatar">{getAvatar(account?.email || rule.accountId)}</div>
                    <div className="listener-info">
                      <div className="listener-name">{account?.email || rule.accountId}</div>
                      <div className="listener-meta">
                        {rule.folders.length > 0 ? rule.folders.join(', ') : 'Inbox'} &nbsp;·&nbsp;
                        Keywords: {rule.keywords.slice(0, 3).join(', ')}
                        {rule.keywords.length > 3 && ` +${rule.keywords.length - 3}`}
                        <br />
                        <span style={{ opacity: 0.85 }}>
                          Future
                          {rule.senderScope === 'specific' && rule.senderAddresses?.length
                            ? ` · Senders: ${rule.senderAddresses.slice(0, 2).join(', ')}${
                                rule.senderAddresses.length > 2 ? '…' : ''
                              }`
                            : ''}
                        </span>
                      </div>
                    </div>
                    <div className="listener-tags">
                      {panel && (
                        <span className="stag stag-panel" title={`Panel: ${panel.name}`}>
                          <i className="fas fa-server stag-lock"></i>{panel.name}
                        </span>
                      )}
                      {isAdmin && (
                        <span
                          className={`stag stag-admin${
                            account?.panelId || account?.auth?.type === 'token' ? ' stag-clickable' : ''
                          }`}
                          title={
                            account?.auth?.type === 'token'
                              ? 'Open Microsoft Exchange admin center in your default browser'
                              : account?.panelId
                                ? 'Open panel admin in-app'
                                : 'Admin — link a panel or use a token account'
                          }
                          role={account?.panelId || account?.auth?.type === 'token' ? 'button' : undefined}
                          style={{
                            cursor: account?.panelId || account?.auth?.type === 'token' ? 'pointer' : 'default',
                          }}
                          onClick={
                            account?.panelId || account?.auth?.type === 'token'
                              ? (e) => {
                                  e.stopPropagation();
                                  void openPanelAdminDashboard(account!.id).catch(err =>
                                    alert(err instanceof Error ? err.message : String(err))
                                  );
                                }
                              : undefined
                          }
                        >
                          <i className="fas fa-lock stag-lock"></i>Admin ↗
                        </span>
                      )}
                    </div>
                    <div className="listener-status">
                      <span className={`status-pill ${rule.status === 'active' ? 'active' : 'expired'}`}>
                        {rule.status === 'active' ? 'Active' : 'Paused'}
                      </span>
                    </div>
                    <div className="listener-actions">
                      <button
                        className="icon-btn"
                        title={rule.status === 'active' ? 'Pause listener' : 'Resume listener'}
                        onClick={() => handleToggleRule(rule.id)}
                        disabled={loading}
                      >
                        <i className={`fas fa-${rule.status === 'active' ? 'pause' : 'play'}`}></i>
                      </button>
                      <button
                        className="icon-btn"
                        title="Delete listener"
                        onClick={() => handleDeleteRule(rule.id)}
                        disabled={loading}
                      >
                        <i className="fas fa-trash"></i>
                      </button>
                    </div>
                  </div>
                );
              })
            )}

            {/* Token Watcher (system listener) */}
            <div className="listener-row">
              <div className="listener-avatar" style={{ background: 'linear-gradient(135deg,#8b5cf6,#7c3aed)' }}>⚙</div>
              <div className="listener-info">
                <div className="listener-name">Token Watcher — All Panels</div>
                <div className="listener-meta">
                  Captures new tokens across Production &amp; Backup &nbsp;·&nbsp; System listener
                </div>
              </div>
              <div className="listener-tags">
                <span className="stag stag-autorefresh">
                  <i className="fas fa-lock stag-lock"></i>autorefresh
                </span>
              </div>
              <div className="listener-status">
                <span className="status-pill active">Active</span>
              </div>
              <div className="listener-actions">
                <button className="icon-btn" title="Pause listener" disabled>
                  <i className="fas fa-pause"></i>
                </button>
                <button className="icon-btn" title="Delete listener" disabled>
                  <i className="fas fa-trash"></i>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* RECENT FINDINGS & ALERTS */}
      <div className="monitoring-card" style={{ marginTop: '24px' }}>
        <div className="monitoring-card-header">
          <div className="monitoring-card-title">
            <i className="fas fa-bell" style={{ color: '#f59e0b' }}></i> Alerts
            <span className="badge" style={{ background: '#f59e0b', marginLeft: '4px' }}>
              {unreadAlerts} new
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="action-btn secondary mon-header-btn"
              onClick={handleMarkAllRead}
              disabled={loading || alerts.length === 0}
            >
              <i className="fas fa-check-double"></i> Mark All Read
            </button>
            <button
              className="action-btn secondary mon-header-btn"
              onClick={() => void handleDeleteAllAlerts()}
              disabled={loading || alerts.length === 0}
              style={{ borderColor: '#fecaca', color: '#b91c1c' }}
            >
              <i className="fas fa-trash-alt"></i> Delete All
            </button>
          </div>
        </div>
        <div className="monitoring-card-body">
          <div className="findings-table">
            <div className="ft-row ft-header">
              <div className="ft-time">Time</div>
              <div className="ft-account">Account</div>
              <div className="ft-panel">Tags</div>
              <div className="ft-details">Details</div>
              <div className="ft-actions">Actions</div>
            </div>
            {alerts.length === 0 ? (
              <div className="ft-row" style={{ justifyContent: 'center', padding: '20px', color: '#9ca3af' }}>
                No alerts yet.
              </div>
            ) : (
              alerts.slice(0, 10).map(alert => {
                const account = accounts.find(a => a.id === alert.accountId);
                const panel = getPanelForAccount(alert.accountId);
                const scenario = getScenarioBadge(getScenarioType(alert));
                return (
                  <div className="ft-row" key={alert.id}>
                    <div className="ft-time">{formatAlertTime(alert.timestamp)}</div>
                    <div className="ft-account">{account?.email || alert.accountId}</div>
                    <div className="ft-panel" style={{ flexWrap: 'wrap', gap: '3px' }}>
                      {panel && (
                        <span className="stag stag-panel" title={`Panel: ${panel.name}`}>
                          <i className="fas fa-server stag-lock"></i>{panel.name}
                        </span>
                      )}
                      {account?.tags?.includes('admin') && (
                        <span className="stag stag-admin">
                          <i className="fas fa-lock stag-lock"></i>Admin
                        </span>
                      )}
                      <span className="stag stag-autorefresh">
                        <i className="fas fa-lock stag-lock"></i>autorefresh
                      </span>
                    </div>
                    <div className="ft-details">
                      <span className={`alert-type-badge ${scenario.cls}`}>{scenario.label}</span>
                      {alert.subject} — matched:{' '}
                      <strong>{alert.matchedKeyword || 'folder'}</strong>
                    </div>
                    <div className="ft-actions">
                      <button
                        className="icon-btn"
                        title="Open email"
                        onClick={() => alert('Open email not implemented')}
                        disabled={loading}
                      >
                        <i className="fas fa-eye"></i>
                      </button>
                      <button
                        className="icon-btn"
                        title="Dismiss alert"
                        onClick={() => handleDeleteAlert(alert.id)}
                        disabled={loading}
                      >
                        <i className="fas fa-trash"></i>
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MonitoringView;