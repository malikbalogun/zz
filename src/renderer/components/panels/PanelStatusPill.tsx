import React from 'react';

type EffectiveStatus = 'connected' | 'live' | 'disconnected' | 'connecting' | 'disconnecting' | 'reconnecting' | 'error';

const STATUS_LABELS: Record<EffectiveStatus, string> = {
  connected: 'Connected',
  live: 'Live',
  disconnected: 'Disconnected',
  connecting: 'Connecting\u2026',
  disconnecting: 'Disconnecting\u2026',
  reconnecting: 'Reconnecting\u2026',
  error: 'Error',
};

const PILL_CLASSES: Record<EffectiveStatus, string> = {
  connected: 'pcard-pill-connected',
  live: 'pcard-pill-live',
  disconnected: 'pcard-pill-disconnected',
  connecting: 'pcard-pill-connecting',
  disconnecting: 'pcard-pill-disconnecting',
  reconnecting: 'pcard-pill-reconnecting',
  error: 'pcard-pill-error',
};

interface PanelStatusPillProps {
  effectiveStatus: EffectiveStatus;
}

const PanelStatusPill: React.FC<PanelStatusPillProps> = ({ effectiveStatus }) => (
  <div className={`pcard-status-pill ${PILL_CLASSES[effectiveStatus]}`}>
    <span className={`pcard-dot${effectiveStatus === 'live' ? ' pcard-dot-pulse' : ''}`} />
    {STATUS_LABELS[effectiveStatus]}
  </div>
);

export default PanelStatusPill;
