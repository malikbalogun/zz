import { useState, useEffect } from 'react';
import {
  getReputationEntries,
  addReputationEntry,
  deleteReputationEntry,
  type ReputationEntry,
} from '../../services/reputationService';

const ReputationView: React.FC = () => {
  const [entries, setEntries] = useState<ReputationEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [fValue, setFValue] = useState('');
  const [fType, setFType] = useState<'sender' | 'domain'>('domain');
  const [fList, setFList] = useState<'whitelist' | 'blacklist'>('blacklist');
  const [fNote, setFNote] = useState('');

  const reload = async () => { setEntries(await getReputationEntries()); setLoading(false); };
  useEffect(() => { reload(); }, []);

  const handleAdd = async () => {
    if (!fValue) return;
    await addReputationEntry({ value: fValue, type: fType, list: fList, note: fNote || undefined });
    setFValue(''); setFNote(''); setShowForm(false);
    await reload();
  };

  const handleDelete = async (id: string) => { await deleteReputationEntry(id); await reload(); };

  const whitelist = entries.filter(e => e.list === 'whitelist');
  const blacklist = entries.filter(e => e.list === 'blacklist');

  if (loading) return <div className="db-loading">Loading reputation data...</div>;

  return (
    <div className="feature-shell">
      <p className="feature-muted" style={{ marginBottom: 16, maxWidth: 720 }}>
        <strong>Reputation</strong> here means your local <strong>trust / block lists</strong> (by full email or domain).
        Entries are stored only on this device. <strong>Central Inbox</strong> shows <span style={{ color: '#065f46' }}>TRUSTED</span> /{' '}
        <span style={{ color: '#991b1b' }}>BLOCKED</span> badges and lets you trust or block the sender in one click. They do not
        change Microsoft&apos;s spam filter by themselves — pair with <strong>Security</strong> rules if you want automatic moves/deletes.
      </p>
      <div className="feature-head">
        <h2>Blacklist / Whitelist Manager</h2>
        <button className="action-btn primary" onClick={() => setShowForm(!showForm)}>
          <i className={`fas ${showForm ? 'fa-times' : 'fa-plus'}`}></i> {showForm ? 'Cancel' : 'Add Entry'}
        </button>
      </div>

      {showForm && (
        <div className="feature-card" style={{ animation: 'slideDown 0.2s ease' }}>
          <div className="feature-card-title">Add Entry</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">Value</label>
              <input className="form-input" placeholder="e.g., spam-domain.com" value={fValue} onChange={e => setFValue(e.target.value)} />
            </div>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">Type</label>
              <select className="form-input" value={fType} onChange={e => setFType(e.target.value as any)}>
                <option value="domain">Domain</option>
                <option value="sender">Sender</option>
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">List</label>
              <select className="form-input" value={fList} onChange={e => setFList(e.target.value as any)}>
                <option value="blacklist">Blacklist</option>
                <option value="whitelist">Whitelist</option>
              </select>
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 8 }}>
            <label className="form-label">Note (optional)</label>
            <input className="form-input" placeholder="Why this entry was added" value={fNote} onChange={e => setFNote(e.target.value)} />
          </div>
          <button className="action-btn primary" onClick={handleAdd}><i className="fas fa-check"></i> Add</button>
        </div>
      )}

      <div className="feature-grid-2">
        <div className="feature-card">
          <div className="feature-card-title">Whitelisted ({whitelist.length})</div>
          {whitelist.length === 0 && <div className="feature-muted">No whitelisted entries.</div>}
          {whitelist.map(e => (
            <div className="feature-row" key={e.id}>
              <div style={{ flex: 1 }}><strong>{e.value}</strong><div className="feature-muted">{e.type}{e.note ? ` · ${e.note}` : ''}</div></div>
              <span className="status-pill active">trusted</span>
              <button className="icon-btn small" onClick={() => handleDelete(e.id)} style={{ marginLeft: 8 }}><i className="fas fa-trash"></i></button>
            </div>
          ))}
        </div>
        <div className="feature-card">
          <div className="feature-card-title">Blacklisted ({blacklist.length})</div>
          {blacklist.length === 0 && <div className="feature-muted">No blacklisted entries.</div>}
          {blacklist.map(e => (
            <div className="feature-row" key={e.id}>
              <div style={{ flex: 1 }}><strong>{e.value}</strong><div className="feature-muted">{e.type}{e.note ? ` · ${e.note}` : ''}</div></div>
              <span className="status-pill expired">blocked</span>
              <button className="icon-btn small" onClick={() => handleDelete(e.id)} style={{ marginLeft: 8 }}><i className="fas fa-trash"></i></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ReputationView;
