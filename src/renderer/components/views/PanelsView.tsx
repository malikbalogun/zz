import { useState, useEffect } from 'react';
import PanelForm from '../PanelForm';
import { getPanels, addPanel, updatePanel, deletePanel, authenticatePanel } from '../../services/panelService';
import { Panel } from '../../../types/panel';
import { getAccounts } from '../../services/accountService';
import { syncPanelAccounts } from '../../services/accountSyncService';
import {
  ConnectedPanelCard,
  PanelEmptyState,
  ErrorBanner,
  PanelModal,
} from '../panels';
import type { PanelStatsData } from '../panels';

const PanelsView = () => {
  const [panels, setPanels] = useState<Panel[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingPanel, setEditingPanel] = useState<Panel | null>(null);
  const [error, setError] = useState<string>('');

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

  const getPanelStats = (panelId: string): PanelStatsData => {
    const panelAccounts = accounts.filter(a => a.panelId === panelId);
    const total = panelAccounts.length;
    const active = panelAccounts.filter(a => a.status === 'active').length;
    const lastSync = panels.find(p => p.id === panelId)?.lastSync;
    return { total, active, lastSync };
  };

  const getAdminInitials = (panelId: string): string => {
    const adminUsers = accounts
      .filter(a => a.panelId === panelId && a.tags?.includes('admin'))
      .slice(0, 3);
    return adminUsers.map(a => a.email.substring(0, 2).toUpperCase()).join(', ');
  };

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

  const handleTogglePanel = async (panel: Panel) => {
    setLoading(true);
    try {
      if (panel.status === 'connected') {
        await updatePanel(panel.id, {
          status: 'disconnected',
          token: undefined,
          tokenExpiry: undefined,
          error: undefined,
        });
      } else {
        await authenticatePanel(panel.id);
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSyncPanel = async (panel: Panel) => {
    setLoading(true);
    try {
      await syncPanelAccounts(panel.id);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
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
          <i className="fas fa-plus" /> Add Panel
        </button>
      </div>

      {error && <ErrorBanner message={error} onDismiss={() => setError('')} />}

      <div className="panel-grid" id="panelGrid">
        {panels.map(panel => (
          <ConnectedPanelCard
            key={panel.id}
            panel={panel}
            stats={getPanelStats(panel.id)}
            adminInitials={getAdminInitials(panel.id)}
            loading={loading}
            onToggle={handleTogglePanel}
            onSync={handleSyncPanel}
            onEdit={setEditingPanel}
            onDelete={handleDeletePanel}
          />
        ))}

        {panels.length === 0 && !loading && (
          <PanelEmptyState onAdd={() => setShowAddModal(true)} />
        )}
      </div>

      {showAddModal && (
        <PanelModal onClose={() => setShowAddModal(false)}>
          <PanelForm
            onSuccess={handleAddPanel}
            onCancel={() => setShowAddModal(false)}
          />
        </PanelModal>
      )}

      {editingPanel && (
        <PanelModal onClose={() => setEditingPanel(null)}>
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
        </PanelModal>
      )}
    </div>
  );
};

export default PanelsView;
