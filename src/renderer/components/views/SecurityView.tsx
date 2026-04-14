import { useState, useEffect, useCallback } from 'react';
import type { UIAccount } from '../../../types/store';
import {
  getSecurityRules,
  addSecurityRule,
  toggleSecurityRule,
  deleteSecurityRule,
  type SecurityRule,
  type SecurityRuleScope,
} from '../../services/securityFilterService';
import { getAccounts } from '../../services/accountService';
import { getSettings, updateSettings } from '../../services/settingsService';
import { runSecurityRulesBatch } from '../../services/securityRuleRunner';
import { restartBackgroundScheduler } from '../../services/backgroundScheduler';

const SecurityView: React.FC = () => {
  const [rules, setRules] = useState<SecurityRule[]>([]);
  const [accounts, setAccounts] = useState<UIAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddRule, setShowAddRule] = useState(false);
  const [filterEnabled, setFilterEnabled] = useState(true);
  const [autoApplyMinutes, setAutoApplyMinutes] = useState(0);
  const [applyTargetAccountId, setApplyTargetAccountId] = useState<string>('');
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyMessage, setApplyMessage] = useState('');

  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'domain' | 'keyword' | 'sender'>('keyword');
  const [newValue, setNewValue] = useState('');
  const [newAction, setNewAction] = useState<'delete' | 'junk' | 'read'>('junk');
  const [newScope, setNewScope] = useState<SecurityRuleScope>('global');
  const [newAccountId, setNewAccountId] = useState('');

  const tokenAccounts = accounts.filter(a => a.auth?.type === 'token' && a.status === 'active');

  const reload = useCallback(async () => {
    const [r, s] = await Promise.all([getSecurityRules(), getSettings()]);
    setRules(r);
    setFilterEnabled(s.security?.filterEnabled !== false);
    setAutoApplyMinutes(s.security?.autoApplyIntervalMinutes ?? 0);
    setLoading(false);
  }, []);

  useEffect(() => {
    void (async () => {
      await reload();
      const accts = await getAccounts();
      setAccounts(accts);
      const firstTok = accts.find(a => a.auth?.type === 'token' && a.status === 'active');
      if (firstTok) setNewAccountId(prev => prev || firstTok.id);
    })();
  }, [reload]);

  const persistSecuritySettings = async (next: Partial<{ filterEnabled: boolean; autoApplyIntervalMinutes: number }>) => {
    const cur = await getSettings();
    await updateSettings({
      security: {
        ...cur.security,
        filterEnabled:
          next.filterEnabled !== undefined ? next.filterEnabled : cur.security?.filterEnabled !== false,
        autoApplyIntervalMinutes:
          next.autoApplyIntervalMinutes !== undefined
            ? next.autoApplyIntervalMinutes
            : (cur.security?.autoApplyIntervalMinutes ?? 0),
      },
    });
    restartBackgroundScheduler();
  };

  const handleToggleFilter = async () => {
    const v = !filterEnabled;
    setFilterEnabled(v);
    await persistSecuritySettings({ filterEnabled: v });
  };

  const handleAutoApplyChange = async (mins: number) => {
    const n = Math.max(0, Math.min(1440, mins));
    setAutoApplyMinutes(n);
    await persistSecuritySettings({ autoApplyIntervalMinutes: n });
  };

  const handleAdd = async () => {
    if (!newName || !newValue) return;
    if (newScope === 'account' && !newAccountId) return;
    try {
      await addSecurityRule({
        name: newName,
        type: newType,
        value: newValue,
        action: newAction,
        active: true,
        scope: newScope,
        accountId: newScope === 'account' ? newAccountId : undefined,
      });
      setNewName('');
      setNewValue('');
      setShowAddRule(false);
      await reload();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setApplyMessage(msg);
      window.setTimeout(() => setApplyMessage(''), 5000);
    }
  };

  const handleToggle = async (id: string) => {
    await toggleSecurityRule(id);
    await reload();
  };
  const handleDelete = async (id: string) => {
    await deleteSecurityRule(id);
    await reload();
  };

  const handleApplyNow = async () => {
    setApplyBusy(true);
    setApplyMessage('');
    try {
      const ids = applyTargetAccountId ? [applyTargetAccountId] : undefined;
      const res = await runSecurityRulesBatch({
        ignoreMasterSwitch: true,
        accountIds: ids,
      });
      const parts = [
        `Processed ${res.accountsProcessed} mailbox(es), ${res.messagesAffected} message action(s).`,
        ...res.errors.slice(0, 5),
      ];
      if (res.errors.length > 5) parts.push(`…and ${res.errors.length - 5} more errors`);
      setApplyMessage(parts.join(' '));
      await reload();
    } catch (e: unknown) {
      setApplyMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setApplyBusy(false);
    }
  };

  const activeRules = rules.filter(r => r.active).length;
  const totalMatches = rules.reduce((s, r) => s + r.matchCount, 0);

  const getActionLabel = (a: string) =>
    ({ delete: 'Auto-Delete', junk: 'Move to Junk', read: 'Mark as Read' }[a] || a);
  const getActionColor = (a: string) =>
    ({ delete: '#dc2626', junk: '#f59e0b', read: '#3b82f6' }[a] || '#6b7280');

  const accountLabel = (id?: string) => {
    if (!id) return '';
    return accounts.find(a => a.id === id)?.email || id;
  };

  if (loading) return <div className="db-loading">Loading security rules...</div>;

  return (
    <div id="securityView">
      {applyMessage && (
        <div
          style={{
            background: '#f0fdf4',
            border: '1px solid #86efac',
            color: '#166534',
            padding: '10px 14px',
            borderRadius: 8,
            marginBottom: 14,
            fontSize: 13,
          }}
        >
          {applyMessage}
        </div>
      )}

      <div className="sec-stats-row">
        <div className="sec-stat-card">
          <div className="sec-stat-icon" style={{ background: 'linear-gradient(135deg,#10b981,#059669)' }}>
            <i className="fas fa-shield-alt"></i>
          </div>
          <div>
            <div className="sec-stat-val">{filterEnabled ? 'ACTIVE' : 'OFF'}</div>
            <div className="sec-stat-label">Filter</div>
          </div>
        </div>
        <div className="sec-stat-card">
          <div className="sec-stat-icon" style={{ background: 'linear-gradient(135deg,#3b82f6,#2563eb)' }}>
            <i className="fas fa-filter"></i>
          </div>
          <div>
            <div className="sec-stat-val">{activeRules}</div>
            <div className="sec-stat-label">Active Rules</div>
          </div>
        </div>
        <div className="sec-stat-card">
          <div className="sec-stat-icon" style={{ background: 'linear-gradient(135deg,#8b5cf6,#7c3aed)' }}>
            <i className="fas fa-trash-alt"></i>
          </div>
          <div>
            <div className="sec-stat-val">{totalMatches}</div>
            <div className="sec-stat-label">Processed</div>
          </div>
        </div>
        <div className="sec-stat-card">
          <div className="sec-stat-icon" style={{ background: 'linear-gradient(135deg,#f59e0b,#d97706)' }}>
            <i className="fas fa-list"></i>
          </div>
          <div>
            <div className="sec-stat-val">{rules.length}</div>
            <div className="sec-stat-label">Total Rules</div>
          </div>
        </div>
      </div>

      <div className="sec-layout">
        <div className="sec-settings-col">
          <div className="sec-card">
            <div className="sec-card-title">
              <i className="fas fa-sliders-h" style={{ color: '#3b82f6' }}></i> Global settings
            </div>
            <div className="sec-toggle-row">
              <div>
                <div className="sec-toggle-label">Security filter</div>
                <div className="sec-toggle-desc">
                  When on, scheduled runs apply rules. &ldquo;Apply now&rdquo; always runs once (per mailbox scope below).
                </div>
              </div>
              <div className={`toggle ${filterEnabled ? 'active' : ''}`} onClick={() => void handleToggleFilter()}>
                <div className="toggle-knob"></div>
              </div>
            </div>
            <div className="form-group" style={{ marginTop: 14 }}>
              <label className="form-label" style={{ fontSize: 11 }}>
                Auto-apply interval (all token mailboxes)
              </label>
              <select
                className="form-input"
                style={{ fontSize: 13, padding: '8px 12px' }}
                value={autoApplyMinutes}
                onChange={e => void handleAutoApplyChange(Number(e.target.value))}
              >
                <option value={0}>Manual only</option>
                <option value={5}>Every 5 minutes</option>
                <option value={15}>Every 15 minutes</option>
                <option value={30}>Every 30 minutes</option>
                <option value={60}>Every hour</option>
              </select>
              <div className="feature-muted" style={{ fontSize: 11, marginTop: 6 }}>
                Scans recent Inbox messages via Microsoft Graph and runs junk/delete/read actions. Requires Mail access on
                your tokens.
              </div>
            </div>

            <div className="form-group" style={{ marginTop: 14 }}>
              <label className="form-label" style={{ fontSize: 11 }}>
                Apply rules now — mailbox
              </label>
              <select
                className="form-input"
                style={{ fontSize: 13, padding: '8px 12px' }}
                value={applyTargetAccountId}
                onChange={e => setApplyTargetAccountId(e.target.value)}
              >
                <option value="">All token mailboxes</option>
                {tokenAccounts.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.email}
                  </option>
                ))}
              </select>
              <button
                className="action-btn primary"
                style={{ marginTop: 10, width: '100%' }}
                type="button"
                disabled={applyBusy || tokenAccounts.length === 0}
                onClick={() => void handleApplyNow()}
              >
                <i className={`fas ${applyBusy ? 'fa-spinner fa-spin' : 'fa-bolt'}`}></i>{' '}
                {applyBusy ? 'Applying…' : 'Apply rules now'}
              </button>
            </div>
          </div>
        </div>

        <div className="sec-rules-col">
          <div className="sec-card">
            <div className="sec-card-header-row">
              <div className="sec-card-title">
                <i className="fas fa-list" style={{ color: '#10b981' }}></i> Rules
              </div>
              <button
                className="action-btn primary"
                style={{ padding: '7px 14px', fontSize: 12 }}
                onClick={() => setShowAddRule(!showAddRule)}
              >
                <i className={`fas ${showAddRule ? 'fa-times' : 'fa-plus'}`}></i> {showAddRule ? 'Cancel' : 'Add rule'}
              </button>
            </div>

            {showAddRule && (
              <div className="sec-add-rule-form">
                <div className="form-group" style={{ marginBottom: 12 }}>
                  <label className="form-label" style={{ fontSize: 11 }}>
                    Rule name
                  </label>
                  <input
                    className="form-input"
                    placeholder="e.g. Block newsletter domain"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    style={{ fontSize: 13, padding: '8px 12px' }}
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 12 }}>
                  <label className="form-label" style={{ fontSize: 11 }}>
                    Applies to
                  </label>
                  <select
                    className="form-input"
                    value={newScope}
                    onChange={e => setNewScope(e.target.value as SecurityRuleScope)}
                    style={{ fontSize: 13, padding: '8px 12px' }}
                  >
                    <option value="global">All mailboxes (global)</option>
                    <option value="account">One mailbox only</option>
                  </select>
                </div>
                {newScope === 'account' && (
                  <div className="form-group" style={{ marginBottom: 12 }}>
                    <label className="form-label" style={{ fontSize: 11 }}>
                      Mailbox
                    </label>
                    <select
                      className="form-input"
                      value={newAccountId}
                      onChange={e => setNewAccountId(e.target.value)}
                      style={{ fontSize: 13, padding: '8px 12px' }}
                    >
                      {tokenAccounts.length === 0 && <option value="">No token accounts</option>}
                      {tokenAccounts.map(a => (
                        <option key={a.id} value={a.id}>
                          {a.email}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 12 }}>
                  <div className="form-group" style={{ flex: 1, marginBottom: 12 }}>
                    <label className="form-label" style={{ fontSize: 11 }}>
                      Type
                    </label>
                    <select
                      className="form-input"
                      value={newType}
                      onChange={e => setNewType(e.target.value as 'domain' | 'keyword' | 'sender')}
                      style={{ fontSize: 13, padding: '8px 12px' }}
                    >
                      <option value="keyword">Keyword</option>
                      <option value="domain">Domain</option>
                      <option value="sender">Sender</option>
                    </select>
                  </div>
                  <div className="form-group" style={{ flex: 1, marginBottom: 12 }}>
                    <label className="form-label" style={{ fontSize: 11 }}>
                      Action
                    </label>
                    <select
                      className="form-input"
                      value={newAction}
                      onChange={e => setNewAction(e.target.value as 'delete' | 'junk' | 'read')}
                      style={{ fontSize: 13, padding: '8px 12px' }}
                    >
                      <option value="delete">Auto-Delete</option>
                      <option value="junk">Move to Junk</option>
                      <option value="read">Mark as Read</option>
                    </select>
                  </div>
                </div>
                <div className="form-group" style={{ marginBottom: 12 }}>
                  <label className="form-label" style={{ fontSize: 11 }}>
                    Value
                  </label>
                  <input
                    className="form-input"
                    placeholder={newType === 'domain' ? 'e.g. evil.com' : 'e.g. password reset'}
                    value={newValue}
                    onChange={e => setNewValue(e.target.value)}
                    style={{ fontSize: 13, padding: '8px 12px' }}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="action-btn secondary" style={{ padding: '7px 14px', fontSize: 12 }} onClick={() => setShowAddRule(false)}>
                    Cancel
                  </button>
                  <button className="action-btn primary" style={{ padding: '7px 14px', fontSize: 12 }} onClick={() => void handleAdd()}>
                    <i className="fas fa-check"></i> Create
                  </button>
                </div>
              </div>
            )}

            <div className="sec-rules-list">
              {rules.length === 0 && (
                <div className="feature-muted" style={{ padding: '16px 0' }}>
                  No security rules yet. Global rules apply to every token mailbox; per-mailbox rules override first (same
                  message: account rule wins before global).
                </div>
              )}
              {rules.map(rule => (
                <div key={rule.id} className={`sec-rule-item ${rule.active ? '' : 'disabled'}`}>
                  <div className="sec-rule-left">
                    <div
                      className={`toggle ${rule.active ? 'active' : ''}`}
                      onClick={() => void handleToggle(rule.id)}
                      style={{ transform: 'scale(0.8)' }}
                    >
                      <div className="toggle-knob"></div>
                    </div>
                    <div className="sec-rule-info">
                      <div className="sec-rule-name">{rule.name}</div>
                      <div className="sec-rule-meta">
                        <span className="sec-rule-type-badge" style={{ background: rule.scope === 'global' ? '#e0e7ff' : '#fef3c7', color: '#4338ca' }}>
                          {rule.scope === 'global' ? 'Global' : accountLabel(rule.accountId)}
                        </span>
                        <span className="sec-rule-type-badge">{rule.type}</span>
                        <span className="sec-rule-value">&quot;{rule.value}&quot;</span>
                      </div>
                    </div>
                  </div>
                  <div className="sec-rule-right">
                    <span className="sec-rule-action" style={{ color: getActionColor(rule.action), background: getActionColor(rule.action) + '15' }}>
                      {getActionLabel(rule.action)}
                    </span>
                    <span className="sec-rule-count">{rule.matchCount} matches</span>
                    <button className="icon-btn small" title="Delete" onClick={() => void handleDelete(rule.id)}>
                      <i className="fas fa-trash"></i>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SecurityView;
