import React from 'react';
import { formatRelativeTime } from '../../utils/time';

export interface PanelStatsData {
  total: number;
  active: number;
  lastSync?: string;
}

interface PanelStatsProps {
  stats: PanelStatsData;
}

const PanelStats: React.FC<PanelStatsProps> = ({ stats }) => {
  const activePercent = stats.total > 0 ? Math.round((stats.active / stats.total) * 100) : 0;
  return (
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
        <div className="pcard-stat-val">{formatRelativeTime(stats.lastSync)}</div>
        <div className="pcard-stat-label">Last Sync</div>
      </div>
    </div>
  );
};

export default PanelStats;
