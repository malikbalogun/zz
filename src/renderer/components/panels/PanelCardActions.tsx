import React from 'react';
import { Panel } from '../../../types/panel';

interface PanelCardActionsProps {
  panel: Panel;
  loading: boolean;
  onToggle: (panel: Panel) => void;
  onSync: (panel: Panel) => void;
  onEdit: (panel: Panel) => void;
  onDelete: (panelId: string) => void;
}

const PanelCardActions: React.FC<PanelCardActionsProps> = ({
  panel,
  loading,
  onToggle,
  onSync,
  onEdit,
  onDelete,
}) => (
  <div className="pcard-footer">
    <label className="toggle-checkbox" title={panel.status === 'connected' ? 'Disconnect' : 'Connect'}>
      <input
        type="checkbox"
        checked={panel.status === 'connected'}
        onChange={() => onToggle(panel)}
        disabled={loading}
      />
      <span className="toggle-slider" />
    </label>
    <div className="pcard-actions-group">
      <button
        className="icon-btn small"
        title="Sync accounts from panel"
        onClick={() => onSync(panel)}
        disabled={loading || panel.status !== 'connected'}
      >
        <i className="fas fa-sync" />
      </button>
      <button
        className="icon-btn small"
        title="Edit panel settings"
        onClick={() => onEdit(panel)}
        disabled={loading}
      >
        <i className="fas fa-edit" />
      </button>
      <button
        className="icon-btn small pcard-delete-btn"
        title="Delete panel"
        onClick={() => onDelete(panel.id)}
        disabled={loading}
      >
        <i className="fas fa-trash" />
      </button>
    </div>
  </div>
);

export default PanelCardActions;
