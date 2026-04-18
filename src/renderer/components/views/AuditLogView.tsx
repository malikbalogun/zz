import { useState, useEffect } from 'react';
import { getAuditLog, clearAuditLog, type AuditEntry } from '../../services/auditLogService';

const AuditLogView: React.FC = () => {
  const [log, setLog] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  const reload = async () => { setLog(await getAuditLog()); setLoading(false); };
  useEffect(() => { reload(); }, []);

  const handleClear = async () => { await clearAuditLog(); await reload(); };

  const categories = ['all', ...new Set(log.map(e => e.category))];
  const filtered = filter === 'all' ? log : log.filter(e => e.category === filter);
  const sorted = [...filtered].reverse();

  if (loading) return <div className="db-loading">Loading audit log...</div>;

  return (
    <div className="feature-shell">
      <div className="feature-head">
        <h2>Logs &amp; Audit Trail</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="action-btn secondary" onClick={handleClear}><i className="fas fa-trash"></i> Clear</button>
        </div>
      </div>
      <div className="feature-kpis" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="feature-kpi"><strong>{log.length}</strong><span>Total Events</span></div>
        <div className="feature-kpi"><strong>{new Set(log.map(e => e.category)).size}</strong><span>Categories</span></div>
        <div className="feature-kpi"><strong>{log.length > 0 ? new Date(log[log.length - 1].timestamp).toLocaleTimeString() : '—'}</strong><span>Last Event</span></div>
      </div>
      <div className="filter-chips" style={{ marginBottom: 12 }}>
        {categories.map(c => (
          <span key={c} className={`chip ${filter === c ? 'active' : ''}`} onClick={() => setFilter(c)}>
            {c === 'all' ? 'All' : c.charAt(0).toUpperCase() + c.slice(1)}
          </span>
        ))}
      </div>
      <div className="feature-card">
        <div className="feature-card-title">Events ({sorted.length})</div>
        {sorted.length === 0 && <div className="feature-muted" style={{ padding: '16px 0' }}>No audit events recorded yet. Events are logged as you use the platform.</div>}
        {sorted.map(e => (
          <div className="feature-row" key={e.id}>
            <div style={{ flex: 1 }}>
              <strong>[{e.category.toUpperCase()}] {e.action}</strong>
              <div className="feature-muted">{e.detail}</div>
            </div>
            <span className="feature-muted">{new Date(e.timestamp).toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default AuditLogView;
