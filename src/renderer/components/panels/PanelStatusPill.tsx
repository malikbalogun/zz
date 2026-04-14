import React from 'react';

interface PanelStatusPillProps {
  status: 'connected' | 'disconnected' | 'error';
}

const STATUS_LABELS: Record<string, string> = {
  connected: 'Connected',
  disconnected: 'Disconnected',
  error: 'Error',
};

const PanelStatusPill: React.FC<PanelStatusPillProps> = ({ status }) => (
  <div className={`pcard-status-pill ${status}`}>
    <span className="pcard-dot" />
    {STATUS_LABELS[status] ?? status}
  </div>
);

export default PanelStatusPill;
