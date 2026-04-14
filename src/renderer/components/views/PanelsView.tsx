import { useState, useEffect, useCallback } from 'react';
import PanelForm from '../PanelForm';
import { getPanels, addPanel, updatePanel, deletePanel, authenticatePanel } from '../../services/panelService';
import { Panel } from '../../../types/panel';
import { getAccounts } from '../../services/accountService';
import { syncPanelAccounts } from '../../services/accountSyncService';
import { websocketManager, WebSocketStatus } from '../../services/websocketService';

type CardAction = 'connecting' | 'disconnecting' | 'syncing' | 'deleting' | null;

interface CardState {
  action: CardAction;
  error: string | null;
  wsStatus: WebSocketStatus;
}

const PanelsView = () => {
  const [panels, setPanels] = useState<Panel[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingPanel, setEditingPanel] = useState<Panel | null>(null);
  const [globalError, setGlobalError] = useState<string>('');

  const [cardStates, setCardStates] = useState<Record<string, CardState>>({});

  const getCardState = useCallback((panelId: string): CardState => {
    return cardStates[panelId] ?? { action: null, error: null, wsStatus: 'disconnected' };
  }, [cardStates]);

  const setCardAction = useCallback((panelId: string, action: CardAction) => {
    setCardStates(prev => ({
      ...prev,
      [panelId]: { ...prev[panelId] ?? { action: null, error: null, wsStatus: 'disconnected' }, action, error: action ? null : (prev[panelId]?.error ?? null) },
    }));
  }, []);

  const setCardError = useCallback((panelId: string, error: string | null) => {
    setCardStates(prev => ({
      ...prev,
      [panelId]: { ...prev[panelId] ?? { action: null, error: null, wsStatus: 'disconnected' }, action: null, error },
    }));
  }, []);

  const loadData = async () => {
    try {
      const [panelsData, accountsData] = await Promise.all([
        getPanels(),
        getAccounts(),
      ]);
      setPanels(panelsData);
      setAccounts(accountsData);
    } catch (err) {
      console.error('Failed to load data:', err);
      setGlobalError('Failed to load panels');
    } finally {
      setInitialLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setCardStates(prev => {
        const next = { ...prev };
        let changed = false;
        for (const panel of panels) {
          const wsStatus = websocketManager.getStatus(panel.id);
          const existing = next[panel.id];
          if (!existing || existing.wsStatus !== wsStatus) {
            next[panel.id] = { ...existing ?? { action: null, error: null, wsStatus: 'disconnected' }, wsStatus };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [panels]);

  const getPanelStats = (panelId: string) => {
    const panelAccounts = accounts.filter(a => a.panelId === panelId);
    const total = panelAccounts.length;
    const active = panelAccounts.filter(a => a.status === 'active').length;
    const lastSync = panels.find(p => p.id === panelId)?.lastSync;
    return { total, active, lastSync };
  };

  const handleAddPanel = async (data: { name: string; url: string; username: string; password?: string }) => {
    if (!data.password) {
      const msg = 'Password is required';
      setGlobalError(msg);
      throw new Error(msg);
    }
    try {
      await addPanel({ ...data, password: data.password });
      setShowAddModal(false);
      await loadData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setGlobalError(msg);
      throw err instanceof Error ? err : new Error(msg);
    }
  };

  const handleEditPanel = (panel: Panel) => {
    setEditingPanel(panel);
  };

  const handleSaveEdit = async (data: { name: string; url: string; username: string; password?: string }) => {
    if (!editingPanel) return;
    setCardAction(editingPanel.id, 'connecting');
    try {
      await updatePanel(editingPanel.id, {
        name: data.name,
        url: data.url,
        username: data.username,
        ...(data.password ? { password: data.password } : {}),
      });
      setEditingPanel(null);
      setCardAction(editingPanel.id, null);
      await loadData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCardError(editingPanel.id, msg);
      throw err instanceof Error ? err : new Error(msg);
    }
  };

  const handleDeletePanel = async (panelId: string) => {
    if (!confirm('Delete this panel? Accounts will be marked as Detached.')) return;
    setCardAction(panelId, 'deleting');
    try {
      await deletePanel(panelId);
      setCardStates(prev => {
        const next = { ...prev };
        delete next[panelId];
        return next;
      });
      await loadData();
    } catch (err) {
      setCardError(panelId, err instanceof Error ? err.message : String(err));
    }
  };

  const handleTogglePanel = async (panel: Panel) => {
    if (panel.status === 'connected') {
      setCardAction(panel.id, 'disconnecting');
      try {
        await updatePanel(panel.id, {
          status: 'disconnected',
          token: undefined,
          tokenExpiry: undefined,
          error: undefined,
        });
        setCardAction(panel.id, null);
        await loadData();
      } catch (err) {
        setCardError(panel.id, err instanceof Error ? err.message : String(err));
      }
    } else {
      setCardAction(panel.id, 'connecting');
      try {
        await authenticatePanel(panel.id);
        setCardAction(panel.id, null);
        await loadData();
      } catch (err) {
        setCardError(panel.id, err instanceof Error ? err.message : String(err));
      }
    }
  };

  const handleSyncPanel = async (panel: Panel) => {
    setCardAction(panel.id, 'syncing');
    try {
      await syncPanelAccounts(panel.id);
      setCardAction(panel.id, null);
      await loadData();
    } catch (err) {
      setCardError(panel.id, err instanceof Error ? err.message : String(err));
    }
  };

  const formatTime = (iso?: string) => {
    if (!iso) return 'Never';
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const getEffectiveStatus = (panel: Panel, cs: CardState): string => {
    if (cs.action === 'connecting') return 'connecting';
    if (cs.action === 'disconnecting') return 'disconnecting';
    if (panel.status === 'reconnecting') return 'reconnecting';
    if (panel.status === 'error') return 'error';
    if (panel.status === 'connected' && cs.wsStatus === 'connected') return 'live';
    if (panel.status === 'connected') return 'connected';
    return 'disconnected';
  };

  const statusConfig: Record<string, { accent: string; icon: string; iconClass: string; pillClass: string; label: string; dotPulse: boolean }> = {
    connected:     { accent: 'pcard-accent-green', icon: 'fas fa-cloud',         iconClass: 'pcard-icon-green', pillClass: 'pcard-pill-connected',     label: 'Connected',     dotPulse: false },
    live:          { accent: 'pcard-accent-green', icon: 'fas fa-bolt',          iconClass: 'pcard-icon-green', pillClass: 'pcard-pill-live',          label: 'Live',          dotPulse: true },
    disconnected:  { accent: 'pcard-accent-gray',  icon: 'fas fa-cloud',         iconClass: 'pcard-icon-gray',  pillClass: 'pcard-pill-disconnected',  label: 'Disconnected',  dotPulse: false },
    connecting:    { accent: 'pcard-accent-blue',  icon: 'fas fa-spinner fa-spin', iconClass: 'pcard-icon-blue',  pillClass: 'pcard-pill-connecting',    label: 'Connecting…',   dotPulse: false },
    disconnecting: { accent: 'pcard-accent-blue',  icon: 'fas fa-spinner fa-spin', iconClass: 'pcard-icon-blue',  pillClass: 'pcard-pill-disconnecting', label: 'Disconnecting…', dotPulse: false },
    reconnecting:  { accent: 'pcard-accent-amber', icon: 'fas fa-sync fa-spin',  iconClass: 'pcard-icon-amber', pillClass: 'pcard-pill-reconnecting',  label: 'Reconnecting…', dotPulse: false },
    error:         { accent: 'pcard-accent-red',   icon: 'fas fa-exclamation-triangle', iconClass: 'pcard-icon-red', pillClass: 'pcard-pill-error', label: 'Error', dotPulse: false },
  };

  if (initialLoading && panels.length === 0 && !showAddModal && !editingPanel) {
    return <div id="panelsView">Loading panels...</div>;
  }

  return (
    <div id="panelsView">
      <div className="section-title">
        Connected Panels
        <button className="add-btn" onClick={() => setShowAddModal(true)}>
          <i className="fas fa-plus"></i> Add Panel
        </button>
      </div>

      {globalError && (
        <div className="error-message" style={{ background: '#fee2e2', color: '#991b1b', padding: '12px', borderRadius: '10px', marginBottom: '20px' }}>
          <i className="fas fa-exclamation-circle"></i> {globalError}
          <button onClick={() => setGlobalError('')} style={{ marginLeft: '12px', background: 'none', border: 'none', color: '#991b1b', cursor: 'pointer' }}>
            <i className="fas fa-times"></i>
          </button>
        </div>
      )}

      <div className="panel-grid" id="panelGrid">
        {panels.map(panel => {
          const stats = getPanelStats(panel.id);
          const cs = getCardState(panel.id);
          const effectiveStatus = getEffectiveStatus(panel, cs);
          const cfg = statusConfig[effectiveStatus] ?? statusConfig.disconnected;
          const activePercent = stats.total > 0 ? Math.round((stats.active / stats.total) * 100) : 0;
          const expiredCount = Math.max(0, stats.total - stats.active);
          const cardBusy = cs.action !== null;
          const cardError = cs.error || panel.error;

          return (
            <div className={`pcard${cardBusy ? ' pcard-busy' : ''}${cardError ? ' pcard-has-error' : ''}`} key={panel.id}>
              <div className={`pcard-accent ${cfg.accent}`}></div>
              <div className="pcard-body">
                <div className="pcard-header">
                  <div className={`pcard-icon ${cfg.iconClass}`}>
                    <i className={cfg.icon}></i>
                  </div>
                  <div className="pcard-title-group">
                    <div className="pcard-name">{panel.name}</div>
                    <div className="pcard-url">{panel.url}</div>
                  </div>
                  <div className={`pcard-status-pill ${cfg.pillClass}`}>
                    <span className={`pcard-dot${cfg.dotPulse ? ' pcard-dot-pulse' : ''}`}></span> {cfg.label}
                  </div>
                </div>

                {cardError && (
                  <div className="pcard-error-inline">
                    <i className="fas fa-exclamation-circle"></i>
                    <span className="pcard-error-text">{cardError}</span>
                    <button
                      className="pcard-error-dismiss"
                      onClick={() => setCardError(panel.id, null)}
                      title="Dismiss"
                    >
                      <i className="fas fa-times"></i>
                    </button>
                  </div>
                )}

                <div className="pcard-divider"></div>
                <div className="pcard-stats">
                  <div className="pcard-stat">
                    <div className="pcard-stat-val">{stats.total}</div>
                    <div className="pcard-stat-label">Accounts</div>
                  </div>
                  <div className="pcard-stat">
                    <div className="pcard-stat-val">{activePercent}%</div>
                    <div className="pcard-stat-label">Active</div>
                  </div>
                  <div className="pcard-stat">
                    <div className="pcard-stat-val">{formatTime(stats.lastSync)}</div>
                    <div className="pcard-stat-label">Last Sync</div>
                  </div>
                </div>
                <div className="pcard-divider"></div>
                <div className="pcard-meta">
                  <span className="pcard-meta-item"><i className="fas fa-user-shield"></i> {panel.username}</span>
                  {cs.wsStatus === 'connected' && panel.status === 'connected' && (
                    <span className="pcard-meta-item pcard-ws-badge">
                      <i className="fas fa-bolt"></i> WebSocket
                    </span>
                  )}
                  {cs.wsStatus === 'connecting' && panel.status === 'connected' && (
                    <span className="pcard-meta-item pcard-ws-connecting">
                      <i className="fas fa-spinner fa-spin"></i> WS connecting
                    </span>
                  )}
                  {cs.wsStatus === 'error' && panel.status === 'connected' && (
                    <span className="pcard-meta-item pcard-ws-error">
                      <i className="fas fa-bolt"></i> WS error
                    </span>
                  )}
                  {expiredCount > 0 ? (
                    <span className="pcard-meta-item"><i className="fas fa-exclamation-triangle" style={{ color: '#f59e0b' }}></i> {expiredCount} expired</span>
                  ) : stats.total > 0 ? (
                    <span className="pcard-meta-item"><i className="fas fa-check-circle" style={{ color: '#10b981' }}></i> Accounts OK</span>
                  ) : (
                    <span className="pcard-meta-item"><i className="fas fa-inbox"></i> No accounts</span>
                  )}
                </div>
                <div className="pcard-footer">
                  <label className="toggle-checkbox">
                    <input
                      type="checkbox"
                      checked={panel.status === 'connected'}
                      onChange={() => handleTogglePanel(panel)}
                      disabled={cardBusy}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className="icon-btn small"
                      title="Sync accounts"
                      onClick={() => handleSyncPanel(panel)}
                      disabled={cardBusy}
                    >
                      <i className={`fas fa-sync${cs.action === 'syncing' ? ' fa-spin' : ''}`}></i>
                    </button>
                    <button
                      className="icon-btn small"
                      title="Edit panel"
                      onClick={() => handleEditPanel(panel)}
                      disabled={cardBusy}
                    >
                      <i className="fas fa-edit"></i>
                    </button>
                    <button
                      className="action-btn secondary delete"
                      style={{ width: '32px', height: '32px', padding: '0', flex: 'none' }}
                      onClick={() => handleDeletePanel(panel.id)}
                      disabled={cardBusy}
                    >
                      <i className={`fas ${cs.action === 'deleting' ? 'fa-spinner fa-spin' : 'fa-trash'}`}></i>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {panels.length === 0 && !initialLoading && (
          <div className="empty-state" style={{ textAlign: 'center', padding: '60px 20px', color: '#6b7280', gridColumn: '1/-1' }}>
            <i className="fas fa-cloud" style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.5 }}></i>
            <h3 style={{ fontSize: '18px', fontWeight: '600', marginBottom: '8px' }}>No panels added yet</h3>
            <p style={{ fontSize: '14px', marginBottom: '24px' }}>Add a webmail panel to start managing accounts</p>
            <button className="add-btn" onClick={() => setShowAddModal(true)}>
              <i className="fas fa-plus"></i> Add Your First Panel
            </button>
          </div>
        )}
      </div>

      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <PanelForm
              onSuccess={handleAddPanel}
              onCancel={() => setShowAddModal(false)}
            />
          </div>
        </div>
      )}

      {editingPanel && (
        <div className="modal-overlay" onClick={() => setEditingPanel(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <PanelForm
              initialData={{
                name: editingPanel.name,
                url: editingPanel.url,
                username: editingPanel.username,
                password: '',
              }}
              onSuccess={handleSaveEdit}
              onCancel={() => setEditingPanel(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default PanelsView;
