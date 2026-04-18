import { useState, useEffect } from 'react';

const WH_STORE_KEY = 'webhookEndpoints';

interface WebhookEndpoint {
  id: string;
  path: string;
  description: string;
  active: boolean;
  createdAt: string;
  lastUsed?: string;
}

const WebhooksView: React.FC = () => {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [fPath, setFPath] = useState('');
  const [fDesc, setFDesc] = useState('');

  const reload = async () => {
    const data = await window.electron.store.get(WH_STORE_KEY);
    setEndpoints(Array.isArray(data) ? data : []);
    setLoading(false);
  };

  useEffect(() => { reload(); }, []);

  const handleAdd = async () => {
    if (!fPath) return;
    const all = await window.electron.store.get(WH_STORE_KEY) || [];
    const entry: WebhookEndpoint = {
      id: crypto.randomUUID(),
      path: fPath.startsWith('/') ? fPath : '/' + fPath,
      description: fDesc,
      active: true,
      createdAt: new Date().toISOString(),
    };
    all.push(entry);
    await window.electron.store.set(WH_STORE_KEY, all);
    setFPath(''); setFDesc(''); setShowForm(false);
    await reload();
  };

  const handleToggle = async (id: string) => {
    const all: WebhookEndpoint[] = await window.electron.store.get(WH_STORE_KEY) || [];
    const idx = all.findIndex(e => e.id === id);
    if (idx !== -1) { all[idx].active = !all[idx].active; await window.electron.store.set(WH_STORE_KEY, all); }
    await reload();
  };

  const handleDelete = async (id: string) => {
    const all: WebhookEndpoint[] = await window.electron.store.get(WH_STORE_KEY) || [];
    await window.electron.store.set(WH_STORE_KEY, all.filter(e => e.id !== id));
    await reload();
  };

  if (loading) return <div className="db-loading">Loading webhooks...</div>;

  return (
    <div className="feature-shell">
      <div className="feature-head">
        <h2>Webhooks &amp; API</h2>
        <button className="action-btn primary" onClick={() => setShowForm(!showForm)}>
          <i className={`fas ${showForm ? 'fa-times' : 'fa-plus'}`}></i> {showForm ? 'Cancel' : 'Add Endpoint'}
        </button>
      </div>

      {showForm && (
        <div className="feature-card" style={{ animation: 'slideDown 0.2s ease' }}>
          <div className="feature-card-title">New Endpoint</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">Path</label>
              <input className="form-input" placeholder="/api/webhooks/leads/import" value={fPath} onChange={e => setFPath(e.target.value)} />
            </div>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">Description</label>
              <input className="form-input" placeholder="Import leads from CRM" value={fDesc} onChange={e => setFDesc(e.target.value)} />
            </div>
          </div>
          <button className="action-btn primary" onClick={handleAdd}><i className="fas fa-check"></i> Create</button>
        </div>
      )}

      <div className="feature-card">
        <div className="feature-card-title">Endpoints ({endpoints.length})</div>
        {endpoints.length === 0 && <div className="feature-muted" style={{ padding: '16px 0' }}>No webhook endpoints configured.</div>}
        {endpoints.map(e => (
          <div className="feature-row" key={e.id}>
            <div style={{ flex: 1 }}>
              <strong>{e.path}</strong>
              <div className="feature-muted">{e.description || 'No description'} · Created {new Date(e.createdAt).toLocaleDateString()}</div>
            </div>
            <span className={`status-pill ${e.active ? 'active' : 'expired'}`} style={{ cursor: 'pointer' }} onClick={() => handleToggle(e.id)}>
              {e.active ? 'active' : 'paused'}
            </span>
            <button className="icon-btn small" title="Delete" onClick={() => handleDelete(e.id)} style={{ marginLeft: 8 }}><i className="fas fa-trash"></i></button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default WebhooksView;
