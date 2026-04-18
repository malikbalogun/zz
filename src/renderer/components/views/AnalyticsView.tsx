import { useState, useEffect } from 'react';
import { getAccounts } from '../../services/accountService';
import { getContacts } from '../../services/contactService';
import { getAutoReplyRules } from '../../services/autoReplyService';
import { getSecurityRules } from '../../services/securityFilterService';
import { getTasks } from '../../services/taskService';
import { getAuditLog } from '../../services/auditLogService';
import { getMonitoringAlerts } from '../../services/monitoringService';

const AnalyticsView: React.FC = () => {
  const [stats, setStats] = useState({
    accounts: 0,
    contacts: 0,
    securityRules: 0,
    securityMatches: 0,
    autoReplyRules: 0,
    autoReplyMatches: 0,
    tasks: 0,
    tasksDone: 0,
    alerts: 0,
    auditEvents: 0,
  });
  const [recentAudit, setRecentAudit] = useState<Array<{ action: string; detail: string; timestamp: string }>>([]);
  const [domainCounts, setDomainCounts] = useState<Array<{ domain: string; count: number }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [accounts, contacts, secRules, arRules, tasks, audit, alerts] = await Promise.all([
          getAccounts(),
          getContacts(),
          getSecurityRules(),
          getAutoReplyRules(),
          getTasks(),
          getAuditLog(),
          getMonitoringAlerts(),
        ]);

        setStats({
          accounts: accounts.length,
          contacts: contacts.length,
          securityRules: secRules.filter(r => r.active).length,
          securityMatches: secRules.reduce((s, r) => s + r.matchCount, 0),
          autoReplyRules: arRules.filter(r => r.enabled).length,
          autoReplyMatches: arRules.reduce((s, r) => s + (r.matchCount || 0), 0),
          tasks: tasks.length,
          tasksDone: tasks.filter(t => t.status === 'done').length,
          alerts: alerts.filter(a => !a.read).length,
          auditEvents: audit.length,
        });

        setRecentAudit(audit.slice(-10).reverse());

        const domainMap: Record<string, number> = {};
        for (const c of contacts) {
          domainMap[c.domain] = (domainMap[c.domain] || 0) + c.emailCount;
        }
        const sorted = Object.entries(domainMap)
          .map(([domain, count]) => ({ domain, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);
        setDomainCounts(sorted);
      } catch (err) {
        console.error('Analytics load error:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="db-loading">Loading analytics...</div>;

  return (
    <div className="feature-shell">
      <div className="feature-head">
        <h2>Analytics Dashboard</h2>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 16 }}>
        <div className="feature-kpi"><strong>{stats.accounts}</strong><span>Accounts</span></div>
        <div className="feature-kpi"><strong>{stats.contacts}</strong><span>Contacts</span></div>
        <div className="feature-kpi"><strong>{stats.securityMatches}</strong><span>Security Matches</span></div>
        <div className="feature-kpi"><strong>{stats.autoReplyMatches}</strong><span>Auto-Reply Matches</span></div>
        <div className="feature-kpi"><strong>{stats.alerts}</strong><span>Unread Alerts</span></div>
      </div>
      <div className="feature-grid-2">
        <div className="feature-card">
          <div className="feature-card-title">Task Summary</div>
          <div className="feature-row"><span>Total Tasks</span><strong>{stats.tasks}</strong></div>
          <div className="feature-row"><span>Completed</span><strong>{stats.tasksDone}</strong></div>
          <div className="feature-row"><span>Open</span><strong>{stats.tasks - stats.tasksDone}</strong></div>
        </div>
        <div className="feature-card">
          <div className="feature-card-title">Rules Active</div>
          <div className="feature-row"><span>Security Rules</span><strong>{stats.securityRules}</strong></div>
          <div className="feature-row"><span>Auto-Reply Rules</span><strong>{stats.autoReplyRules}</strong></div>
          <div className="feature-row"><span>Audit Events</span><strong>{stats.auditEvents}</strong></div>
        </div>
      </div>
      <div className="feature-grid-2" style={{ marginTop: 12 }}>
        <div className="feature-card">
          <div className="feature-card-title">Top Domains by Email Volume</div>
          {domainCounts.length === 0 && <div className="feature-muted">No contact data yet. Extract contacts first.</div>}
          {domainCounts.map(d => (
            <div className="feature-row" key={d.domain}><span>{d.domain}</span><strong>{d.count}</strong></div>
          ))}
        </div>
        <div className="feature-card">
          <div className="feature-card-title">Recent Activity</div>
          {recentAudit.length === 0 && <div className="feature-muted">No audit events yet.</div>}
          {recentAudit.map((e, i) => (
            <div className="feature-row" key={i}>
              <span>[{e.action}] {e.detail}</span>
              <span className="feature-muted">{new Date(e.timestamp).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default AnalyticsView;
