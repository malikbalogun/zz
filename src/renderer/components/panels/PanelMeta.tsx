import React from 'react';
import type { WebSocketStatus } from '../../services/websocketService';

interface PanelMetaProps {
  username: string;
  adminInitials: string;
  totalAccounts: number;
  expiredCount: number;
  wsStatus?: WebSocketStatus;
  panelConnected?: boolean;
}

const PanelMeta: React.FC<PanelMetaProps> = ({
  username,
  adminInitials,
  totalAccounts,
  expiredCount,
  wsStatus,
  panelConnected,
}) => (
  <div className="pcard-meta">
    <span className="pcard-meta-item" title="Admin user">
      <i className="fas fa-user-shield" /> {username}
    </span>
    <span className="pcard-meta-item" title="Admin accounts">
      <i className="fas fa-users" /> {adminInitials || '\u2014'}
    </span>
    {panelConnected && wsStatus === 'connected' && (
      <span className="pcard-meta-item pcard-ws-badge" title="WebSocket active">
        <i className="fas fa-bolt" /> WebSocket
      </span>
    )}
    {panelConnected && wsStatus === 'connecting' && (
      <span className="pcard-meta-item pcard-ws-connecting" title="WebSocket connecting">
        <i className="fas fa-spinner fa-spin" /> WS connecting
      </span>
    )}
    {panelConnected && wsStatus === 'error' && (
      <span className="pcard-meta-item pcard-ws-error" title="WebSocket error">
        <i className="fas fa-bolt" /> WS error
      </span>
    )}
    {expiredCount > 0 ? (
      <span className="pcard-meta-item" title={`${expiredCount} account(s) need attention`}>
        <i className="fas fa-exclamation-triangle" style={{ color: '#f59e0b' }} /> {expiredCount} expired
      </span>
    ) : totalAccounts > 0 ? (
      <span className="pcard-meta-item">
        <i className="fas fa-check-circle" style={{ color: '#10b981' }} /> All accounts OK
      </span>
    ) : (
      <span className="pcard-meta-item">
        <i className="fas fa-inbox" /> No accounts
      </span>
    )}
  </div>
);

export default PanelMeta;
