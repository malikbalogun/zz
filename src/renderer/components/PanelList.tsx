import React, { useEffect, useState } from 'react';
import { Panel } from '../../types/panel';
import * as panelService from '../services/panelService';
import { syncPanelAccounts } from '../services/accountSyncService';
import PanelCard from './PanelCard';

const PanelList: React.FC = () => {
  const [panels, setPanels] = useState<Panel[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPanels();
  }, []);

  const loadPanels = async () => {
    try {
      const data = await panelService.getPanels();
      setPanels(data);
    } catch (error) {
      console.error('Failed to load panels:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this panel?')) return;
    await panelService.deletePanel(id);
    setPanels(panels.filter(p => p.id !== id));
  };

  const handleTestConnection = async (panel: Panel) => {
    try {
      await panelService.authenticatePanel(panel.id);
      // Refresh panel list to show updated status
      await loadPanels();
    } catch (error) {
      alert(`Connection test failed: ${error}`);
    }
  };

  const handleSyncPanel = async (panel: Panel) => {
    try {
      await syncPanelAccounts(panel.id);
      // Refresh panel list to show updated status
      await loadPanels();
    } catch (error) {
      alert(`Sync failed: ${error}`);
    }
  };

  if (loading) {
    return (
      <div className="p-8 text-gray-400">Loading panels...</div>
    );
  }

  if (panels.length === 0) {
    return (
      <div className="p-8 text-center">
        <p className="text-gray-400 mb-4">No panels added yet.</p>
        <p className="text-sm text-gray-500">Click "Add Panel" to connect your first webmail panel.</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-4">Connected Panels</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {panels.map(panel => (
          <PanelCard
            key={panel.id}
            panel={panel}
            onDelete={() => handleDelete(panel.id)}
            onTestConnection={() => handleTestConnection(panel)}
            onSync={() => handleSyncPanel(panel)}
          />
        ))}
      </div>
    </div>
  );
};

export default PanelList;