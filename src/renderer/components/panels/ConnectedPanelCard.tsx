import React from 'react';
import { Panel } from '../../../types/panel';
import PanelStatusPill from './PanelStatusPill';
import PanelStats, { PanelStatsData } from './PanelStats';
import PanelMeta from './PanelMeta';
import PanelCardActions from './PanelCardActions';
import type { CardState } from '../views/PanelsView';

interface ConnectedPanelCardProps {
  panel: Panel;
  stats: PanelStatsData;
  adminInitials: string;
  cardState: CardState;
  onToggle: (panel: Panel) => void;
  onSync: (panel: Panel) => void;
  onEdit: (panel: Panel) => void;
  onDelete: (panelId: string) => void;
  onDismissError: () => void;
}

type EffectiveStatus = 'connected' | 'live' | 'disconnected' | 'connecting' | 'disconnecting' | 'reconnecting' | 'error';

const STATUS_CONFIG: Record<EffectiveStatus, { accent: string; icon: string; iconClass: string }> = {
  connected:     { accent: 'pcard-accent-green', icon: 'fas fa-cloud',                  iconClass: 'pcard-icon-green' },
  live:          { accent: 'pcard-accent-green', icon: 'fas fa-bolt',                   iconClass: 'pcard-icon-green' },
  disconnected:  { accent: 'pcard-accent-gray',  icon: 'fas fa-cloud',                  iconClass: 'pcard-icon-gray'  },
  connecting:    { accent: 'pcard-accent-blue',  icon: 'fas fa-spinner fa-spin',        iconClass: 'pcard-icon-blue'  },
  disconnecting: { accent: 'pcard-accent-blue',  icon: 'fas fa-spinner fa-spin',        iconClass: 'pcard-icon-blue'  },
  reconnecting:  { accent: 'pcard-accent-amber', icon: 'fas fa-sync fa-spin',           iconClass: 'pcard-icon-amber' },
  error:         { accent: 'pcard-accent-red',   icon: 'fas fa-exclamation-triangle',    iconClass: 'pcard-icon-red'   },
};

function getEffectiveStatus(panel: Panel, cs: CardState): EffectiveStatus {
  if (cs.action === 'connecting') return 'connecting';
  if (cs.action === 'disconnecting') return 'disconnecting';
  if (panel.status === 'reconnecting') return 'reconnecting';
  if (panel.status === 'error') return 'error';
  if (panel.status === 'connected' && cs.wsStatus === 'connected') return 'live';
  if (panel.status === 'connected') return 'connected';
  return 'disconnected';
}

const ConnectedPanelCard: React.FC<ConnectedPanelCardProps> = ({
  panel,
  stats,
  adminInitials,
  cardState,
  onToggle,
  onSync,
  onEdit,
  onDelete,
  onDismissError,
}) => {
  const expiredCount = Math.max(0, stats.total - stats.active);
  const effectiveStatus = getEffectiveStatus(panel, cardState);
  const cfg = STATUS_CONFIG[effectiveStatus];
  const cardBusy = cardState.action !== null;
  const cardError = cardState.error || panel.error;

  return (
    <div className={`pcard${cardBusy ? ' pcard-busy' : ''}${cardError ? ' pcard-has-error' : ''}`}>
      <div className={`pcard-accent ${cfg.accent}`} />
      <div className="pcard-body">
        <div className="pcard-header">
          <div className={`pcard-icon ${cfg.iconClass}`}>
            <i className={cfg.icon} />
          </div>
          <div className="pcard-title-group">
            <div className="pcard-name">{panel.name}</div>
            <div className="pcard-url">{panel.url}</div>
          </div>
          <PanelStatusPill effectiveStatus={effectiveStatus} />
        </div>

        {cardError && (
          <div className="pcard-error-inline">
            <i className="fas fa-exclamation-circle" />
            <span className="pcard-error-text">{cardError}</span>
            <button className="pcard-error-dismiss" onClick={onDismissError} title="Dismiss">
              <i className="fas fa-times" />
            </button>
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
          wsStatus={cardState.wsStatus}
          panelConnected={panel.status === 'connected'}
        />
        <PanelCardActions
          panel={panel}
          cardBusy={cardBusy}
          cardAction={cardState.action}
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
