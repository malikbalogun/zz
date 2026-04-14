import { useState, useEffect } from 'react';
import type { FollowUpTask } from '../../../types/store';
import { getTasks, addTask, updateTask, deleteTask, completeTask } from '../../services/taskService';

type StatusFilter = 'all' | 'pending' | 'in_progress' | 'done' | 'urgent';

const TaskManagerView: React.FC = () => {
  const [tasks, setTasks] = useState<FollowUpTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [showForm, setShowForm] = useState(false);

  const [fTitle, setFTitle] = useState('');
  const [fDesc, setFDesc] = useState('');
  const [fOwner, setFOwner] = useState('');
  const [fDue, setFDue] = useState('');
  const [fStatus, setFStatus] = useState<FollowUpTask['status']>('pending');

  const reload = async () => {
    const data = await getTasks();
    setTasks(data);
    setLoading(false);
  };

  useEffect(() => { reload(); }, []);

  const handleAdd = async () => {
    if (!fTitle) return;
    await addTask({
      title: fTitle,
      description: fDesc || undefined,
      owner: fOwner || undefined,
      status: fStatus,
      dueAt: fDue || undefined,
    });
    setShowForm(false);
    setFTitle(''); setFDesc(''); setFOwner(''); setFDue('');
    await reload();
  };

  const handleComplete = async (id: string) => { await completeTask(id); await reload(); };
  const handleDelete = async (id: string) => { await deleteTask(id); await reload(); };
  const handleCycleStatus = async (t: FollowUpTask) => {
    const order: FollowUpTask['status'][] = ['pending', 'in_progress', 'urgent', 'done'];
    const next = order[(order.indexOf(t.status) + 1) % order.length];
    await updateTask(t.id, { status: next });
    await reload();
  };

  const filtered = filter === 'all' ? tasks : tasks.filter(t => t.status === filter);
  const openCount = tasks.filter(t => t.status !== 'done').length;
  const urgentCount = tasks.filter(t => t.status === 'urgent').length;
  const doneCount = tasks.filter(t => t.status === 'done').length;

  if (loading) return <div className="db-loading">Loading tasks...</div>;

  return (
    <div className="feature-shell">
      <div className="feature-head">
        <h2>Task &amp; Follow-up Manager</h2>
        <button className="action-btn primary" onClick={() => setShowForm(!showForm)}>
          <i className={`fas ${showForm ? 'fa-times' : 'fa-plus'}`}></i> {showForm ? 'Cancel' : 'New Task'}
        </button>
      </div>

      <div className="feature-kpis">
        <div className="feature-kpi"><strong>{tasks.length}</strong><span>Total</span></div>
        <div className="feature-kpi"><strong>{openCount}</strong><span>Open</span></div>
        <div className="feature-kpi"><strong>{urgentCount}</strong><span>Urgent</span></div>
        <div className="feature-kpi"><strong>{doneCount}</strong><span>Done</span></div>
      </div>

      {/* Filter chips */}
      <div className="filter-chips" style={{ marginBottom: 12 }}>
        {(['all', 'pending', 'in_progress', 'urgent', 'done'] as StatusFilter[]).map(s => (
          <span key={s} className={`chip ${filter === s ? 'active' : ''}`} onClick={() => setFilter(s)}>
            {s === 'all' ? 'All' : s === 'in_progress' ? 'In Progress' : s.charAt(0).toUpperCase() + s.slice(1)}
          </span>
        ))}
      </div>

      {showForm && (
        <div className="feature-card" style={{ animation: 'slideDown 0.2s ease', marginBottom: 12 }}>
          <div className="feature-card-title">Create Task</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">Title</label>
              <input className="form-input" placeholder="Follow-up on invoice" value={fTitle} onChange={e => setFTitle(e.target.value)} />
            </div>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">Owner</label>
              <input className="form-input" placeholder="john.doe" value={fOwner} onChange={e => setFOwner(e.target.value)} />
            </div>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">Due Date</label>
              <input className="form-input" type="datetime-local" value={fDue} onChange={e => setFDue(e.target.value)} />
            </div>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">Priority</label>
              <select className="form-input" value={fStatus} onChange={e => setFStatus(e.target.value as any)}>
                <option value="pending">Pending</option>
                <option value="in_progress">In Progress</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 8 }}>
            <label className="form-label">Description</label>
            <textarea className="form-input" rows={3} placeholder="Optional details..." value={fDesc} onChange={e => setFDesc(e.target.value)} />
          </div>
          <button className="action-btn primary" onClick={handleAdd} style={{ marginTop: 4 }}>
            <i className="fas fa-check"></i> Create Task
          </button>
        </div>
      )}

      <div className="feature-card">
        <div className="feature-card-title">Task Queue ({filtered.length})</div>
        {filtered.length === 0 && <div className="feature-muted" style={{ padding: '16px 0' }}>No tasks match the current filter.</div>}
        {filtered.map(t => (
          <div className="feature-row" key={t.id}>
            <div style={{ flex: 1 }}>
              <strong style={t.status === 'done' ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}>{t.title}</strong>
              <div className="feature-muted">
                {t.owner ? `Owner: ${t.owner}` : 'No owner'}
                {t.dueAt ? ` · Due: ${new Date(t.dueAt).toLocaleString()}` : ''}
                {t.emailSubject ? ` · Email: ${t.emailSubject}` : ''}
              </div>
            </div>
            <span
              className={`status-pill ${t.status === 'done' ? 'active' : t.status === 'urgent' ? 'expired' : 'active'}`}
              style={{ cursor: 'pointer' }}
              onClick={() => handleCycleStatus(t)}
              title="Click to cycle status"
            >
              {t.status}
            </span>
            {t.status !== 'done' && (
              <button className="icon-btn small" title="Complete" onClick={() => handleComplete(t.id)} style={{ marginLeft: 8 }}>
                <i className="fas fa-check"></i>
              </button>
            )}
            <button className="icon-btn small" title="Delete" onClick={() => handleDelete(t.id)} style={{ marginLeft: 4 }}>
              <i className="fas fa-trash"></i>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TaskManagerView;
