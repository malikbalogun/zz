import React from 'react';
import { Panel } from '../../../types/panel';
import type { CardAction } from '../views/PanelsView';

interface PanelCardActionsProps {
  panel: Panel;
  cardBusy: boolean;
  cardAction: CardAction;
  onToggle: (panel: Panel) => void;
  onSync: (panel: Panel) => void;
  onEdit: (panel: Panel) => void;
  onDelete: (panelId: string) => void;
}

const PanelCardActions: React.FC<PanelCardActionsProps> = ({
  panel,
  cardBusy,
  cardAction,
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
        disabled={cardBusy}
      />
      <span className="toggle-slider" />
    </label>
    <div className="pcard-actions-group">
      <button
        className="icon-btn small"
        title="Sync accounts from panel"
        onClick={() => onSync(panel)}
        disabled={cardBusy || panel.status !== 'connected'}
      >
        <i className={`fas fa-sync${cardAction === 'syncing' ? ' fa-spin' : ''}`} />
      </button>
      <button
        className="icon-btn small"
        title="Edit panel settings"
        onClick={() => onEdit(panel)}
        disabled={cardBusy}
      >
        <i className="fas fa-edit" />
      </button>
      <button
        className="icon-btn small pcard-delete-btn"
        title="Delete panel"
        onClick={() => onDelete(panel.id)}
        disabled={cardBusy}
      >
        <i className={`fas ${cardAction === 'deleting' ? 'fa-spinner fa-spin' : 'fa-trash'}`} />
      </button>
    </div>
  </div>
);

export default PanelCardActions;
