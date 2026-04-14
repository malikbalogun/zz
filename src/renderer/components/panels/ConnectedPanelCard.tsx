import React from 'react';
import { Panel } from '../../../types/panel';
import PanelStatusPill from './PanelStatusPill';
import PanelStats, { PanelStatsData } from './PanelStats';
import PanelMeta from './PanelMeta';
import PanelCardActions from './PanelCardActions';

interface ConnectedPanelCardProps {
  panel: Panel;
  stats: PanelStatsData;
  adminInitials: string;
  loading: boolean;
  onToggle: (panel: Panel) => void;
  onSync: (panel: Panel) => void;
  onEdit: (panel: Panel) => void;
  onDelete: (panelId: string) => void;
}

function getAccentClass(status: Panel['status']) {
  return status === 'connected' ? 'pcard-accent-green' : 'pcard-accent-amber';
}

function getIconClass(status: Panel['status']) {
  return status === 'connected' ? 'pcard-icon-green' : 'pcard-icon-amber';
}

const ConnectedPanelCard: React.FC<ConnectedPanelCardProps> = ({
  panel,
  stats,
  adminInitials,
  loading,
  onToggle,
  onSync,
  onEdit,
  onDelete,
}) => {
  const expiredCount = Math.max(0, stats.total - stats.active);

  return (
    <div className="pcard">
      <div className={`pcard-accent ${getAccentClass(panel.status)}`} />
      <div className="pcard-body">
        <div className="pcard-header">
          <div className={`pcard-icon ${getIconClass(panel.status)}`}>
            <i className="fas fa-cloud" />
          </div>
          <div className="pcard-title-group">
            <div className="pcard-name">{panel.name}</div>
            <div className="pcard-url">{panel.url}</div>
          </div>
          <PanelStatusPill status={panel.status} />
        </div>

        {panel.error && (
          <div className="pcard-error">
            <i className="fas fa-exclamation-circle" /> {panel.error}
          </div>
        )}

        <div className="pcard-divider" />
        <PanelStats stats={stats} />
        <div className="pcard-divider" />
        <PanelMeta
          username={panel.username}
          adminInitials={adminInitials}
          totalAccounts={stats.total}
          expiredCount={expiredCount}
        />
        <PanelCardActions
          panel={panel}
          loading={loading}
          onToggle={onToggle}
          onSync={onSync}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </div>
    </div>
  );
};

export default ConnectedPanelCard;
