import { useState, useEffect, useCallback } from 'react';
import PanelForm from '../PanelForm';
import { getPanels, addPanel, updatePanel, deletePanel, authenticatePanel } from '../../services/panelService';
import { Panel } from '../../../types/panel';
import { getAccounts } from '../../services/accountService';
import { syncPanelAccounts } from '../../services/accountSyncService';
import { websocketManager, WebSocketStatus } from '../../services/websocketService';
import {
  ConnectedPanelCard,
  PanelEmptyState,
  ErrorBanner,
  PanelModal,
} from '../panels';
import type { PanelStatsData } from '../panels';

export type CardAction = 'connecting' | 'disconnecting' | 'syncing' | 'deleting' | null;

export interface CardState {
  action: CardAction;
  error: string | null;
  wsStatus: WebSocketStatus;
}

const DEFAULT_CARD_STATE: CardState = { action: null, error: null, wsStatus: 'disconnected' };

const PanelsView = () => {
  const [panels, setPanels] = useState<Panel[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingPanel, setEditingPanel] = useState<Panel | null>(null);
  const [globalError, setGlobalError] = useState<string>('');

  const [cardStates, setCardStates] = useState<Record<string, CardState>>({});

  const getCardState = useCallback((panelId: string): CardState => {
    return cardStates[panelId] ?? DEFAULT_CARD_STATE;
  }, [cardStates]);

  const setCardAction = useCallback((panelId: string, action: CardAction) => {
    setCardStates(prev => ({
      ...prev,
      [panelId]: { ...(prev[panelId] ?? DEFAULT_CARD_STATE), action, error: action ? null : (prev[panelId]?.error ?? null) },
    }));
  }, []);

  const setCardError = useCallback((panelId: string, error: string | null) => {
    setCardStates(prev => ({
      ...prev,
      [panelId]: { ...(prev[panelId] ?? DEFAULT_CARD_STATE), action: null, error },
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
            next[panel.id] = { ...(existing ?? DEFAULT_CARD_STATE), wsStatus };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [panels]);

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

  if (initialLoading && panels.length === 0 && !showAddModal && !editingPanel) {
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

      {globalError && <ErrorBanner message={globalError} onDismiss={() => setGlobalError('')} />}

      <div className="panel-grid" id="panelGrid">
        {panels.map(panel => {
          const cs = getCardState(panel.id);
          return (
            <ConnectedPanelCard
              key={panel.id}
              panel={panel}
              stats={getPanelStats(panel.id)}
              adminInitials={getAdminInitials(panel.id)}
              cardState={cs}
              onToggle={handleTogglePanel}
              onSync={handleSyncPanel}
              onEdit={setEditingPanel}
              onDelete={handleDeletePanel}
              onDismissError={() => setCardError(panel.id, null)}
            />
          );
        })}

        {panels.length === 0 && !initialLoading && (
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
