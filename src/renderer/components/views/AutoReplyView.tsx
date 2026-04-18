import { useState, useEffect, useMemo } from 'react';
import type { AutoReplyRule, AutoReplyScope, AutoReplyActionType, AutoReplyTriggerType } from '../../../types/store';
import type { UIAccount } from '../../../types/store';
import {
  getAutoReplyRules,
  addAutoReplyRule,
  deleteAutoReplyRule,
  toggleAutoReplyRule,
} from '../../services/autoReplyService';
import { getAccounts } from '../../services/accountService';
import { getSettings, updateSettings } from '../../services/settingsService';
import { restartBackgroundScheduler } from '../../services/backgroundScheduler';
import { runAutoReplyBatch } from '../../services/autoReplyRunner';
import { getOutlookService } from '../../services/outlookService';
import type { OutlookMessage } from '../../services/outlookService';

const DELAY_OPTIONS = [0, 1, 2, 3, 5, 10, 15, 30];

const AutoReplyView: React.FC = () => {
  const [rules, setRules] = useState<AutoReplyRule[]>([]);
  const [accounts, setAccounts] = useState<UIAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  const [engineEnabled, setEngineEnabled] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(5);
  const [runBusy, setRunBusy] = useState(false);
  const [runNote, setRunNote] = useState('');

  const [fName, setFName] = useState('');
  const [fScope, setFScope] = useState<AutoReplyScope>('account');
  const [fAccount, setFAccount] = useState('');
  const [fAction, setFAction] = useState<AutoReplyActionType>('reply');
  const [fTrigger, setFTrigger] = useState<AutoReplyTriggerType>('sender');
  const [fValue, setFValue] = useState('');
  const [fAckAll, setFAckAll] = useState(false);
  const [fDelay, setFDelay] = useState(3);
  const [fSubject, setFSubject] = useState('');
  const [fBody, setFBody] = useState('');

  const [pickerAccount, setPickerAccount] = useState('');
  const [anchorFolder, setAnchorFolder] = useState<'inbox' | 'sent'>('inbox');
  const [anchorMessages, setAnchorMessages] = useState<OutlookMessage[]>([]);
  const [anchorLoading, setAnchorLoading] = useState(false);
  const [selectedAnchorId, setSelectedAnchorId] = useState('');

  const tokenAccounts = useMemo(
    () => accounts.filter(a => a.auth?.type === 'token' && a.status === 'active'),
    [accounts]
  );

  const selectedAnchor = useMemo(
    () => anchorMessages.find(m => m.id === selectedAnchorId),
    [anchorMessages, selectedAnchorId]
  );

  const reload = async () => {
    const [r, a, s] = await Promise.all([getAutoReplyRules(), getAccounts(), getSettings()]);
    setRules(r);
    setAccounts(a);
    setEngineEnabled(s.autoReply?.engineEnabled === true);
    setIntervalMinutes(s.autoReply?.intervalMinutes ?? 5);
    const tok = a.filter(x => x.auth?.type === 'token' && x.status === 'active');
    if (tok.length) {
      setFAccount(prev => prev || tok[0].id);
      setPickerAccount(prev => prev || tok[0].id);
    }
    setLoading(false);
  };

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    if (!showForm || fTrigger !== 'conversation' || !pickerAccount) return;
    let cancelled = false;
    (async () => {
      setAnchorLoading(true);
      try {
        const acct = tokenAccounts.find(x => x.id === pickerAccount);
        if (!acct) return;
        const Outlook = getOutlookService();
        const folders = await Outlook.listFolders(acct);
        const inbox = folders.find(f => f.displayName.toLowerCase() === 'inbox');
        const sent = folders.find(f => f.displayName.toLowerCase().includes('sent'));
        const folderId =
          anchorFolder === 'sent' ? sent?.id || 'sentitems' : inbox?.id || 'inbox';
        const msgs = await Outlook.fetchMessages(acct, folderId, undefined, 50);
        if (!cancelled) {
          setAnchorMessages(msgs);
          setSelectedAnchorId('');
        }
      } catch (e) {
        console.error(e);
        if (!cancelled) setAnchorMessages([]);
      } finally {
        if (!cancelled) setAnchorLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showForm, fTrigger, pickerAccount, anchorFolder, tokenAccounts]);

  const persistAutoReplySettings = async (next: Partial<{ engineEnabled: boolean; intervalMinutes: number }>) => {
    const cur = await getSettings();
    const merged = {
      engineEnabled: cur.autoReply?.engineEnabled === true,
      intervalMinutes: cur.autoReply?.intervalMinutes ?? 5,
      ...cur.autoReply,
    };
    if (next.engineEnabled !== undefined) merged.engineEnabled = next.engineEnabled;
    if (next.intervalMinutes !== undefined) merged.intervalMinutes = next.intervalMinutes;
    await updateSettings({ autoReply: merged });
    restartBackgroundScheduler();
  };

  const handleEngineToggle = async () => {
    const v = !engineEnabled;
    setEngineEnabled(v);
    await persistAutoReplySettings({ engineEnabled: v });
  };

  const handleIntervalChange = async (mins: number) => {
    const n = Math.max(1, Math.min(180, mins));
    setIntervalMinutes(n);
    await persistAutoReplySettings({ intervalMinutes: n });
  };

  const handleRunNow = async () => {
    setRunBusy(true);
    setRunNote('');
    try {
      const res = await runAutoReplyBatch({ ignoreEngineOff: true });
      setRunNote(
        `Done: ${res.actionsTaken} action(s) across ${res.accountsProcessed} mailbox(es). ${res.errors.slice(0, 3).join(' ')}`
      );
    } catch (e: unknown) {
      setRunNote(e instanceof Error ? e.message : String(e));
    } finally {
      setRunBusy(false);
    }
  };

  const handleAdd = async () => {
    if (!fName) return;
    if (fScope === 'account' && !fAccount) return;
    if (fTrigger === 'all' && !fAckAll) return;
    if (fTrigger === 'conversation') {
      if (!selectedAnchor?.conversationId) {
        setRunNote('Pick a message that has a conversation id (try another message).');
        return;
      }
    }
    try {
      await addAutoReplyRule({
        name: fName,
        enabled: true,
        scope: fScope,
        accountId: fScope === 'account' ? fAccount : undefined,
        action: fAction,
        triggerType: fTrigger,
        triggerValue: fValue,
        referenceMessageId: fTrigger === 'conversation' ? selectedAnchor?.id : undefined,
        referenceConversationId: fTrigger === 'conversation' ? selectedAnchor?.conversationId : undefined,
        referenceSubjectHint: fTrigger === 'conversation' ? selectedAnchor?.subject : undefined,
        ackAllInboxRisk: fTrigger === 'all' ? fAckAll : false,
        delayMinutes: fDelay,
        templateSubject: fSubject,
        templateBody: fAction === 'reply' ? fBody : '',
      });
      setShowForm(false);
      setFName('');
      setFValue('');
      setFSubject('');
      setFBody('');
      setFAckAll(false);
      setSelectedAnchorId('');
      await reload();
    } catch (e: unknown) {
      setRunNote(e instanceof Error ? e.message : String(e));
    }
  };

  const handleToggle = async (id: string) => {
    await toggleAutoReplyRule(id);
    await reload();
  };
  const handleDelete = async (id: string) => {
    await deleteAutoReplyRule(id);
    await reload();
  };

  const activeCount = rules.filter(r => r.enabled).length;
  const totalMatches = rules.reduce((s, r) => s + (r.matchCount || 0), 0);

  const triggerHelp =
    fTrigger === 'conversation'
      ? 'Choose Inbox or Sent, then a message. Incoming mail in the same thread (same ConversationId) matches — e.g. replies after you sent from Sent.'
      : fTrigger === 'all'
        ? 'Matches every message in Inbox (except mail from yourself). Dangerous — confirm below.'
        : '';

  if (loading) return <div className="db-loading">Loading auto-reply rules...</div>;

  return (
    <div className="feature-shell">
      <div className="feature-head">
        <h2>Auto-Reply &amp; auto-actions</h2>
        <button className="action-btn primary" onClick={() => setShowForm(!showForm)}>
          <i className={`fas ${showForm ? 'fa-times' : 'fa-plus'}`}></i> {showForm ? 'Cancel' : 'New rule'}
        </button>
      </div>

      {runNote && (
        <div
          style={{
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            color: '#1e3a8a',
            padding: '10px 14px',
            borderRadius: 8,
            marginBottom: 12,
            fontSize: 13,
          }}
        >
          {runNote}
        </div>
      )}

      <div className="feature-card" style={{ marginBottom: 14 }}>
        <div className="feature-card-title">Engine</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
          <div className="sec-toggle-row" style={{ margin: 0 }}>
            <div>
              <div className="sec-toggle-label">Background runner</div>
              <div className="sec-toggle-desc" style={{ fontSize: 12 }}>
                When on, processes Inbox on an interval. Use token accounts with Mail send/receive permission.
              </div>
            </div>
            <div className={`toggle ${engineEnabled ? 'active' : ''}`} onClick={() => void handleEngineToggle()}>
              <div className="toggle-knob"></div>
            </div>
          </div>
          <div className="form-group" style={{ margin: 0, minWidth: 200 }}>
            <label className="form-label">Interval (minutes)</label>
            <select
              className="form-input"
              value={intervalMinutes}
              onChange={e => void handleIntervalChange(Number(e.target.value))}
            >
              {[3, 5, 10, 15, 30, 60].map(m => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </div>
          <button
            className="action-btn secondary"
            type="button"
            disabled={runBusy || tokenAccounts.length === 0}
            onClick={() => void handleRunNow()}
          >
            <i className={`fas ${runBusy ? 'fa-spinner fa-spin' : 'fa-play'}`}></i> Run now (once)
          </button>
        </div>
      </div>

      <div className="feature-kpis">
        <div className="feature-kpi">
          <strong>{rules.length}</strong>
          <span>Total rules</span>
        </div>
        <div className="feature-kpi">
          <strong>{activeCount}</strong>
          <span>Active</span>
        </div>
        <div className="feature-kpi">
          <strong>{totalMatches}</strong>
          <span>Actions</span>
        </div>
        <div className="feature-kpi">
          <strong>{tokenAccounts.length}</strong>
          <span>Token mailboxes</span>
        </div>
      </div>

      {showForm && (
        <div className="feature-card" style={{ animation: 'slideDown 0.2s ease' }}>
          <div className="feature-card-title">Create rule</div>
          <p className="feature-muted" style={{ marginBottom: 12, fontSize: 13 }}>
            Global rules run on every token mailbox; account rules only on one mailbox. Per-mailbox rules are evaluated
            before global. First matching rule wins per message. Use Security for bulk junk rules without replies.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">Name</label>
              <input className="form-input" placeholder="e.g. Auto-answer project thread" value={fName} onChange={e => setFName(e.target.value)} />
            </div>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">Scope</label>
              <select className="form-input" value={fScope} onChange={e => setFScope(e.target.value as AutoReplyScope)}>
                <option value="account">One mailbox</option>
                <option value="global">All mailboxes</option>
              </select>
            </div>
            {fScope === 'account' && (
              <div className="form-group" style={{ marginBottom: 8 }}>
                <label className="form-label">Mailbox</label>
                <select className="form-input" value={fAccount} onChange={e => setFAccount(e.target.value)}>
                  {tokenAccounts.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.email}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">Action</label>
              <select className="form-input" value={fAction} onChange={e => setFAction(e.target.value as AutoReplyActionType)}>
                <option value="reply">Send auto-reply</option>
                <option value="delete">Delete message</option>
                <option value="junk">Move to Junk</option>
                <option value="mark_read">Mark as read</option>
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">When (trigger)</label>
              <select
                className="form-input"
                value={fTrigger}
                onChange={e => {
                  setFTrigger(e.target.value as AutoReplyTriggerType);
                  setFAckAll(false);
                  setSelectedAnchorId('');
                }}
              >
                <option value="sender">Sender contains / domain</option>
                <option value="keyword">Keyword in subject or preview</option>
                <option value="subject">Subject contains</option>
                <option value="thread">Subject contains (legacy)</option>
                <option value="conversation">Same thread as selected message</option>
                <option value="all">Every Inbox message (risky)</option>
              </select>
            </div>
            {fTrigger !== 'all' && fTrigger !== 'conversation' && (
              <div className="form-group" style={{ marginBottom: 8, gridColumn: '1 / -1' }}>
                <label className="form-label">Match value</label>
                <input
                  className="form-input"
                  placeholder={
                    fTrigger === 'sender' ? 'spam@evil.com or evil.com' : 'invoice, password reset, …'
                  }
                  value={fValue}
                  onChange={e => setFValue(e.target.value)}
                />
              </div>
            )}
            {fTrigger === 'all' && (
              <div className="form-group" style={{ marginBottom: 8, gridColumn: '1 / -1' }}>
                <label className="form-label" style={{ color: '#b45309' }}>
                  <input type="checkbox" checked={fAckAll} onChange={e => setFAckAll(e.target.checked)} /> I understand this
                  applies to every Inbox message (except from myself)
                </label>
              </div>
            )}
            {fTrigger === 'conversation' && (
              <>
                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label className="form-label">Load anchor from mailbox</label>
                  <select className="form-input" value={pickerAccount} onChange={e => setPickerAccount(e.target.value)}>
                    {tokenAccounts.map(a => (
                      <option key={a.id} value={a.id}>
                        {a.email}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label className="form-label">Folder</label>
                  <select
                    className="form-input"
                    value={anchorFolder}
                    onChange={e => setAnchorFolder(e.target.value as 'inbox' | 'sent')}
                  >
                    <option value="inbox">Inbox</option>
                    <option value="sent">Sent Items</option>
                  </select>
                </div>
                <div className="form-group" style={{ marginBottom: 8, gridColumn: '1 / -1' }}>
                  <label className="form-label">Anchor message (thread)</label>
                  {anchorLoading ? (
                    <div className="feature-muted">Loading…</div>
                  ) : (
                    <select
                      className="form-input"
                      value={selectedAnchorId}
                      onChange={e => setSelectedAnchorId(e.target.value)}
                    >
                      <option value="">Select a message…</option>
                      {anchorMessages.map(m => (
                        <option key={m.id} value={m.id}>
                          {(m.subject || '(no subject)').slice(0, 70)} — {m.from?.emailAddress?.address || '?'}
                        </option>
                      ))}
                    </select>
                  )}
                  {selectedAnchor && (
                    <div className="feature-muted" style={{ fontSize: 12, marginTop: 6 }}>
                      Conversation id: {selectedAnchor.conversationId || '— (API may omit; pick another message)'}
                    </div>
                  )}
                </div>
              </>
            )}
            <div className="form-group" style={{ marginBottom: 8 }}>
              <label className="form-label">Delay (minutes after receive)</label>
              <select className="form-input" value={fDelay} onChange={e => setFDelay(Number(e.target.value))}>
                {DELAY_OPTIONS.map(d => (
                  <option key={d} value={d}>
                    {d} min
                  </option>
                ))}
              </select>
            </div>
            {fAction === 'reply' && (
              <>
                <div className="form-group" style={{ marginBottom: 8, gridColumn: '1 / -1' }}>
                  <label className="form-label">Reply subject hint (optional; reply usually keeps Re:)</label>
                  <input
                    className="form-input"
                    placeholder="Re: {{original_subject}}"
                    value={fSubject}
                    onChange={e => setFSubject(e.target.value)}
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 8, gridColumn: '1 / -1' }}>
                  <label className="form-label">Reply body (HTML stripped for send; use {'{{original_subject}}'})</label>
                  <textarea className="form-input" rows={4} value={fBody} onChange={e => setFBody(e.target.value)} />
                </div>
              </>
            )}
          </div>
          {triggerHelp && (
            <p className="feature-muted" style={{ fontSize: 12, marginTop: 8 }}>
              {triggerHelp}
            </p>
          )}
          <button className="action-btn primary" onClick={() => void handleAdd()} style={{ marginTop: 8 }}>
            <i className="fas fa-check"></i> Create rule
          </button>
        </div>
      )}

      <div className="feature-card">
        <div className="feature-card-title">Rules</div>
        {rules.length === 0 && (
          <div className="feature-muted" style={{ padding: '16px 0' }}>
            No rules yet. Combine triggers (sender, subject, conversation anchor) with reply or delete/junk/read.
          </div>
        )}
        {rules.map(r => (
          <div key={r.id} className="feature-row" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <strong>{r.name}</strong>
              <div className="feature-muted" style={{ fontSize: 12 }}>
                <span style={{ fontWeight: 600 }}>{r.scope === 'global' ? 'Global' : accounts.find(a => a.id === r.accountId)?.email || r.accountId}</span>
                {' · '}
                {r.action} · {r.triggerType}
                {r.triggerValue ? ` · "${r.referenceSubjectHint || r.triggerValue}"` : ''}
                {r.referenceConversationId ? ` · thread ${r.referenceConversationId.slice(0, 12)}…` : ''}
                {' · '}
                delay {r.delayMinutes}m
              </div>
            </div>
            <span className={`status-pill ${r.enabled ? 'active' : 'expired'}`}>{r.enabled ? 'active' : 'paused'}</span>
            <button className="icon-btn small" title="Toggle" onClick={() => void handleToggle(r.id)} style={{ marginLeft: 8 }}>
              <i className={`fas ${r.enabled ? 'fa-pause' : 'fa-play'}`}></i>
            </button>
            <button className="icon-btn small" title="Delete" onClick={() => void handleDelete(r.id)} style={{ marginLeft: 4 }}>
              <i className="fas fa-trash"></i>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default AutoReplyView;
