import React from 'react';

interface PanelMetaProps {
  username: string;
  adminInitials: string;
  totalAccounts: number;
  expiredCount: number;
}

const PanelMeta: React.FC<PanelMetaProps> = ({
  username,
  adminInitials,
  totalAccounts,
  expiredCount,
}) => (
  <div className="pcard-meta">
    <span className="pcard-meta-item" title="Admin user">
      <i className="fas fa-user-shield" /> {username}
    </span>
    <span className="pcard-meta-item" title="Admin accounts">
      <i className="fas fa-users" /> {adminInitials || '—'}
    </span>
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
