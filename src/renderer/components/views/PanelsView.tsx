import { useState, useEffect } from 'react';
import PanelForm from '../PanelForm';
import { getPanels, addPanel, updatePanel, deletePanel, authenticatePanel } from '../../services/panelService';
import { Panel } from '../../../types/panel';
import { getAccounts } from '../../services/accountService';
import { syncPanelAccounts } from '../../services/accountSyncService';

const PanelsView = () => {
  const [panels, setPanels] = useState<Panel[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingPanel, setEditingPanel] = useState<Panel | null>(null);
  const [error, setError] = useState<string>('');

  // Load panels and accounts
  const loadData = async () => {
    setLoading(true);
    try {
      const [panelsData, accountsData] = await Promise.all([
        getPanels(),
        getAccounts(),
      ]);
      setPanels(panelsData);
      setAccounts(accountsData);
    } catch (err) {
      console.error('Failed to load data:', err);
      setError('Failed to load panels');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Compute panel stats
  const getPanelStats = (panelId: string) => {
    const panelAccounts = accounts.filter(a => a.panelId === panelId);
    const total = panelAccounts.length;
    const active = panelAccounts.filter(a => a.status === 'active').length;
    const lastSync = panels.find(p => p.id === panelId)?.lastSync;
    return { total, active, lastSync };
  };

  // Add panel
  const handleAddPanel = async (data: { name: string; url: string; username: string; password?: string }) => {
    if (!data.password) {
      const msg = 'Password is required';
      setError(msg);
      throw new Error(msg);
    }
    setLoading(true);
    try {
      await addPanel({ ...data, password: data.password });
      setShowAddModal(false);
      await loadData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err instanceof Error ? err : new Error(msg);
    } finally {
      setLoading(false);
    }
  };

  // Edit panel
  const handleEditPanel = (panel: Panel) => {
    setEditingPanel(panel);
  };

  const handleSaveEdit = async (data: { name: string; url: string; username: string; password?: string }) => {
    if (!editingPanel) return;
    setLoading(true);
    try {
      await updatePanel(editingPanel.id, {
        name: data.name,
        url: data.url,
        username: data.username,
        ...(data.password ? { password: data.password } : {}),
      });
      setEditingPanel(null);
      await loadData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err instanceof Error ? err : new Error(msg);
    } finally {
      setLoading(false);
    }
  };

  // Delete panel
  const handleDeletePanel = async (panelId: string) => {
    if (!confirm('Delete this panel? Accounts will be marked as Detached.')) return;
    setLoading(true);
    try {
      await deletePanel(panelId);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // Toggle enable/disable (simple status toggle)
  const handleTogglePanel = async (panel: Panel) => {
    setLoading(true);
    try {
      if (panel.status === 'connected') {
        // Disconnect: clear token and set status
        await updatePanel(panel.id, {
          status: 'disconnected',
          token: undefined,
          tokenExpiry: undefined,
          error: undefined,
        });
      } else {
        // Connect: authenticate and get token
        await authenticatePanel(panel.id);
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };



  // Sync accounts from panel
  const handleSyncPanel = async (panel: Panel) => {
    setLoading(true);
    try {
      await syncPanelAccounts(panel.id);
      await loadData(); // refresh panels and accounts
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // Format time
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

  // Get panel accent color
  const getAccentClass = (panel: Panel) => {
    if (panel.status === 'connected') return 'pcard-accent-green';
    if (panel.status === 'error') return 'pcard-accent-amber';
    return 'pcard-accent-amber';
  };

  // Get panel icon class
  const getIconClass = (panel: Panel) => {
    if (panel.status === 'connected') return 'pcard-icon-green';
    if (panel.status === 'error') return 'pcard-icon-amber';
    return 'pcard-icon-amber';
  };

  // Full-page loader only when not adding/editing a panel. Otherwise setLoading(true)
  // with zero panels would replace the whole view and unmount the modal (broken inputs/save).
  if (loading && panels.length === 0 && !showAddModal && !editingPanel) {
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

      {error && (
        <div className="error-message" style={{ background: '#fee2e2', color: '#991b1b', padding: '12px', borderRadius: '10px', marginBottom: '20px' }}>
          <i className="fas fa-exclamation-circle"></i> {error}
          <button onClick={() => setError('')} style={{ marginLeft: '12px', background: 'none', border: 'none', color: '#991b1b', cursor: 'pointer' }}>
            <i className="fas fa-times"></i>
          </button>
        </div>
      )}

      <div className="panel-grid" id="panelGrid">
        {panels.map(panel => {
          const stats = getPanelStats(panel.id);
          const activePercent = stats.total > 0 ? Math.round((stats.active / stats.total) * 100) : 0;
          const expiredCount = Math.max(0, stats.total - stats.active);
          const adminUsers = accounts.filter(a => a.panelId === panel.id && a.tags?.includes('admin')).slice(0, 3);
          const adminInitials = adminUsers.map(a => a.email.substring(0, 2).toUpperCase()).join(', ');

          return (
            <div className="pcard" key={panel.id}>
              <div className={`pcard-accent ${getAccentClass(panel)}`}></div>
              <div className="pcard-body">
                <div className="pcard-header">
                  <div className={`pcard-icon ${getIconClass(panel)}`}>
                    <i className="fas fa-cloud"></i>
                  </div>
                  <div className="pcard-title-group">
                    <div className="pcard-name">{panel.name}</div>
                    <div className="pcard-url">{panel.url}</div>
                  </div>
                  <div className={`pcard-status-pill ${panel.status}`}>
                    <span className="pcard-dot"></span> {panel.status}
                  </div>
                </div>
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
                  <span className="pcard-meta-item"><i className="fas fa-users"></i> {adminInitials || '—'}</span>
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
                      disabled={loading}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className="icon-btn small"
                      title="Sync accounts"
                      onClick={() => handleSyncPanel(panel)}
                      disabled={loading}
                    >
                      <i className="fas fa-sync"></i>
                    </button>
                    <button
                      className="icon-btn small"
                      title="Edit panel"
                      onClick={() => handleEditPanel(panel)}
                      disabled={loading}
                    >
                      <i className="fas fa-edit"></i>
                    </button>
                    <button
                      className="action-btn secondary delete"
                      style={{ width: '32px', height: '32px', padding: '0', flex: 'none' }}
                      onClick={() => handleDeletePanel(panel.id)}
                      disabled={loading}
                    >
                      <i className="fas fa-trash"></i>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {panels.length === 0 && !loading && (
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

      {/* Add Panel Modal */}
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

      {/* Edit Panel Modal */}
      {editingPanel && (
        <div className="modal-overlay" onClick={() => setEditingPanel(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <PanelForm
              initialData={{
                name: editingPanel.name,
                url: editingPanel.url,
                username: editingPanel.username,
                password: '', // password not stored in plaintext
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