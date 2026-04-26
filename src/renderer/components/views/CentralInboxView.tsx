import { useState, useEffect } from 'react';
import type { UIAccount, MonitoringAlert } from '../../../types/store';
import { getAccounts } from '../../services/accountService';
import { getMonitoringAlerts } from '../../services/monitoringService';
import { OutlookService } from '../../services/outlookService';
import type { OutlookMessage, OutlookFolder } from '../../services/outlookService';
import {
  getReputationEntries,
  matchReputation,
  addReputationEntry,
  type ReputationEntry,
} from '../../services/reputationService';
import {
  collectMessagesForExport,
  formatExportCsv,
  formatExportTxt,
  saveExportWithDialog,
  type EmailExportScope,
  type ExportFormat,
} from '../../services/emailExportService';
import { translateHtmlBody } from '../../services/translatorService';

type MonitorRowHit = { keywords: string[]; read: boolean };
type SavedInboxView = {
  id: string;
  name: string;
  accountId: string;
  folderId: string;
  query: string;
};
const SAVED_VIEWS_KEY = 'inboxSavedViews';
const INBOX_PAGE_SIZE = 50;

function buildMonitorHitMap(alerts: MonitoringAlert[], accountId: string): Record<string, MonitorRowHit> {
  const map: Record<string, MonitorRowHit> = {};
  for (const a of alerts) {
    if (a.accountId !== accountId || !a.emailId) continue;
    const prev = map[a.emailId];
    if (!prev) {
      map[a.emailId] = { keywords: [a.matchedKeyword], read: a.read };
    } else {
      if (!prev.keywords.includes(a.matchedKeyword)) prev.keywords.push(a.matchedKeyword);
      if (!a.read) prev.read = false;
    }
  }
  return map;
}

const CentralInboxView: React.FC = () => {
  const [accounts, setAccounts] = useState<UIAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [folders, setFolders] = useState<OutlookFolder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string>('inbox');
  const [messages, setMessages] = useState<OutlookMessage[]>([]);
  const [selectedMsg, setSelectedMsg] = useState<OutlookMessage | null>(null);
  const [msgBody, setMsgBody] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMoreMessages, setLoadingMoreMessages] = useState(false);
  const [messageNextLink, setMessageNextLink] = useState<string | null>(null);
  const [messageMode, setMessageMode] = useState<'folder' | 'search'>('folder');
  const [loadingBody, setLoadingBody] = useState(false);
  const [error, setError] = useState('');
  const [showReplyBox, setShowReplyBox] = useState(false);
  const [replyText, setReplyText] = useState('');
  // Translation state — cached per messageId so re-clicking is instant.
  const [translations, setTranslations] = useState<Record<string, { text: string; sourceLang?: string }>>({});
  const [translating, setTranslating] = useState(false);
  const [translationError, setTranslationError] = useState('');
  // Whether the reader is currently *showing* the translation vs. the original.
  const [showTranslation, setShowTranslation] = useState(false);
  const [monitorHits, setMonitorHits] = useState<Record<string, MonitorRowHit>>({});
  const [reputationEntries, setReputationEntries] = useState<ReputationEntry[]>([]);
  const [savedViews, setSavedViews] = useState<SavedInboxView[]>([]);
  const [preferredFolderId, setPreferredFolderId] = useState<string | null>(null);
  const [pendingApplyAccountId, setPendingApplyAccountId] = useState<string | null>(null);
  const [pendingApplyQuery, setPendingApplyQuery] = useState<string | null>(null);

  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] = useState<EmailExportScope>('current_folder');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('csv');
  const [exportMaxPerFolder, setExportMaxPerFolder] = useState(2000);
  const [exportFromFilter, setExportFromFilter] = useState('');
  const [exportAccountIds, setExportAccountIds] = useState<Set<string>>(new Set());
  const [exportBusy, setExportBusy] = useState(false);
  const [exportStatus, setExportStatus] = useState('');

  useEffect(() => {
    setExportAccountIds(new Set(accounts.map(a => a.id)));
  }, [accounts]);

  useEffect(() => {
    const loadRep = async () => setReputationEntries(await getReputationEntries());
    void loadRep();
    const onRep = () => void loadRep();
    window.addEventListener('reputation-changed', onRep);
    return () => window.removeEventListener('reputation-changed', onRep);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const data = await window.electron.store.get(SAVED_VIEWS_KEY);
        setSavedViews(Array.isArray(data) ? data : []);
      } catch {
        setSavedViews([]);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const accts = await getAccounts();
        const tokenAccounts = accts.filter(a => a.auth?.type === 'token' && a.status === 'active');
        setAccounts(tokenAccounts);
        if (tokenAccounts.length > 0) {
          setSelectedAccountId(tokenAccounts[0].id);
        }
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const selectedAccount = accounts.find(a => a.id === selectedAccountId);

  // Load folders when account changes
  useEffect(() => {
    if (!selectedAccount) return;
    setFolders([]);
    (async () => {
      try {
        setError('');
        const f = await OutlookService.listFolders(selectedAccount);
        setFolders(f);
        if (f.length > 0) {
          const preferred = preferredFolderId && f.some(fd => fd.id === preferredFolderId) ? preferredFolderId : null;
          const inbox = f.find(fd => fd.displayName.toLowerCase() === 'inbox');
          setSelectedFolderId(preferred || inbox?.id || f[0].id);
          setPreferredFolderId(null);
        }
      } catch (err: any) {
        console.error('Failed to load folders:', err);
        setError(err?.message || 'Failed to load mailbox folders');
        setFolders([]);
      }
    })();
  }, [selectedAccountId, preferredFolderId]);

  useEffect(() => {
    if (!selectedAccountId) {
      setMonitorHits({});
      return;
    }
    let cancelled = false;
    const refreshHits = async () => {
      try {
        const alerts = await getMonitoringAlerts();
        if (cancelled) return;
        setMonitorHits(buildMonitorHitMap(alerts, selectedAccountId));
      } catch {
        if (!cancelled) setMonitorHits({});
      }
    };
    refreshHits();
    const t = window.setInterval(refreshHits, 45000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [selectedAccountId]);

  // Load messages when folder changes
  useEffect(() => {
    if (!selectedAccount || !selectedFolderId) return;
    loadMessages();
  }, [selectedFolderId, selectedAccountId]);

  useEffect(() => {
    if (!pendingApplyAccountId || pendingApplyAccountId !== selectedAccountId || !selectedFolderId) return;
    if (pendingApplyQuery && pendingApplyQuery.trim()) {
      void handleSearch();
    } else {
      void loadMessages();
    }
    setPendingApplyAccountId(null);
    setPendingApplyQuery(null);
  }, [pendingApplyAccountId, pendingApplyQuery, selectedAccountId, selectedFolderId]);

  const loadMessages = async () => {
    if (!selectedAccount) return;
    setLoadingMessages(true);
    setError('');
    setSelectedMsg(null);
    setMsgBody('');
    setMessageMode('folder');
    setMessageNextLink(null);
    try {
      const page = await OutlookService.fetchMessagesPage(selectedAccount, {
        folderId: selectedFolderId,
        limit: INBOX_PAGE_SIZE,
      });
      setMessages(page.messages);
      setMessageNextLink(page.nextLink || null);
      try {
        const alerts = await getMonitoringAlerts();
        setMonitorHits(buildMonitorHitMap(alerts, selectedAccountId));
      } catch {
        /* keep prior highlights */
      }
    } catch (err: any) {
      setError(`Failed to load messages: ${err.message}`);
      setMessages([]);
    } finally {
      setLoadingMessages(false);
    }
  };

  const loadMoreMessages = async () => {
    if (!selectedAccount || !messageNextLink || messageMode !== 'folder') return;
    setLoadingMoreMessages(true);
    setError('');
    try {
      const page = await OutlookService.fetchMessagesPage(selectedAccount, { pageUrl: messageNextLink });
      setMessages(prev => [...prev, ...page.messages]);
      setMessageNextLink(page.nextLink || null);
      try {
        const alerts = await getMonitoringAlerts();
        setMonitorHits(buildMonitorHitMap(alerts, selectedAccountId));
      } catch {
        /* keep prior highlights */
      }
    } catch (err: any) {
      setError(`Failed to load more messages: ${err.message}`);
    } finally {
      setLoadingMoreMessages(false);
    }
  };

  const handleSearch = async () => {
    if (!selectedAccount || !searchQuery.trim()) return;
    setLoadingMessages(true);
    setError('');
    setSelectedMsg(null);
    setMsgBody('');
    setMessageMode('search');
    setMessageNextLink(null);
    try {
      const results = await OutlookService.searchMessages(selectedAccount, searchQuery, undefined, 40);
      setMessages(results);
      try {
        const alerts = await getMonitoringAlerts();
        setMonitorHits(buildMonitorHitMap(alerts, selectedAccountId));
      } catch {
        /* keep prior highlights */
      }
    } catch (err: any) {
      setError(`Search failed: ${err.message}`);
    } finally {
      setLoadingMessages(false);
    }
  };

  const saveCurrentView = async () => {
    const name = window.prompt('Save current inbox view as:');
    if (!name?.trim()) return;
    const entry: SavedInboxView = {
      id: crypto.randomUUID(),
      name: name.trim(),
      accountId: selectedAccountId,
      folderId: selectedFolderId,
      query: searchQuery.trim(),
    };
    const next = [...savedViews, entry].slice(-20);
    setSavedViews(next);
    await window.electron.store.set(SAVED_VIEWS_KEY, next);
  };

  const applySavedView = async (id: string) => {
    const v = savedViews.find(x => x.id === id);
    if (!v) return;
    setPreferredFolderId(v.folderId);
    setSelectedAccountId(v.accountId);
    setSearchQuery(v.query);
    setPendingApplyAccountId(v.accountId);
    setPendingApplyQuery(v.query);
  };

  const deleteSavedView = async (id: string) => {
    const next = savedViews.filter(v => v.id !== id);
    setSavedViews(next);
    await window.electron.store.set(SAVED_VIEWS_KEY, next);
  };

  const handleSelectMessage = async (msg: OutlookMessage) => {
    setSelectedMsg(msg);
    setShowReplyBox(false);
    setMsgBody('');
    setShowTranslation(false);
    setTranslationError('');
    if (!selectedAccount) return;
    setLoadingBody(true);
    try {
      const details = await OutlookService.getMessageDetails(selectedAccount, msg.id);
      setMsgBody(details.body.content);
    } catch (err: any) {
      setMsgBody(`<p style="color:#ef4444">Failed to load body: ${err.message}</p>`);
    } finally {
      setLoadingBody(false);
    }
  };

  const formatTime = (iso: string) => {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString();
  };

  const getDomainFromEmail = (email?: string) => email?.split('@')[1] || '';

  const toggleExportAccount = (id: string) => {
    setExportAccountIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runExport = async () => {
    if (!selectedAccount) return;
    if (exportScope === 'selected_accounts_all_folders' && exportAccountIds.size === 0) {
      setError('Select at least one mailbox for export.');
      return;
    }
    setExportBusy(true);
    setExportStatus('Starting…');
    try {
      const folderMeta = folders.find(f => f.id === selectedFolderId);
      const rows = await collectMessagesForExport({
        scope: exportScope,
        primaryAccount: selectedAccount,
        primaryFolderId: selectedFolderId,
        primaryFolderName: folderMeta?.displayName || selectedFolderId,
        selectedAccountIds: Array.from(exportAccountIds),
        maxPerFolder: exportMaxPerFolder,
        fromFilter: exportFromFilter,
        onProgress: (label, n) => setExportStatus(`${label} — ${n} rows`),
      });
      const content = exportFormat === 'csv' ? formatExportCsv(rows) : formatExportTxt(rows);
      const saved = await saveExportWithDialog(content, exportFormat);
      if (saved.ok) {
        setExportStatus(`Saved ${rows.length} message${rows.length === 1 ? '' : 's'}${saved.path ? ` → ${saved.path}` : ''}`);
      } else {
        setExportStatus(rows.length ? 'Export cancelled (no file saved)' : 'Cancelled');
      }
    } catch (err: any) {
      setExportStatus('');
      setError(err?.message || String(err));
    } finally {
      setExportBusy(false);
    }
  };

  const handleTranslateBody = async () => {
    if (!selectedMsg) return;
    setTranslationError('');
    // Already translated? Just toggle visibility.
    if (translations[selectedMsg.id]) {
      setShowTranslation(true);
      return;
    }
    if (!msgBody) {
      setTranslationError('Email body has not loaded yet.');
      return;
    }
    setTranslating(true);
    try {
      const result = await translateHtmlBody(msgBody);
      setTranslations(prev => ({
        ...prev,
        [selectedMsg.id]: { text: result.translated, sourceLang: result.sourceLang },
      }));
      setShowTranslation(true);
    } catch (err: any) {
      setTranslationError(err?.message || String(err));
    } finally {
      setTranslating(false);
    }
  };

  if (loading) return <div className="db-loading">Loading accounts...</div>;
  if (accounts.length === 0) {
    return (
      <div className="inbox-reader-empty" style={{ height: '60vh' }}>
        <i className="fas fa-envelope-open-text"></i>
        <h3>No active accounts</h3>
        <p>Add an account with a valid token to start reading emails.</p>
      </div>
    );
  }

  return (
    <div id="centralInboxView">
      {/* Toolbar */}
      <div className="inbox-toolbar">
        <div className="inbox-toolbar-left">
          <select
            className="inbox-account-select"
            value={selectedAccountId}
            onChange={e => setSelectedAccountId(e.target.value)}
          >
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.email}</option>
            ))}
          </select>
          <select
            className="inbox-account-select"
            value={selectedFolderId}
            onChange={e => setSelectedFolderId(e.target.value)}
          >
            {folders.map(f => (
              <option key={f.id} value={f.id}>
                {f.displayName} ({f.unreadItemCount}/{f.totalItemCount})
              </option>
            ))}
          </select>
          <button className="action-btn secondary" onClick={loadMessages} style={{ padding: '7px 14px' }}>
            <i className={`fas fa-sync ${loadingMessages ? 'fa-spin' : ''}`}></i>
          </button>
        </div>
        <div className="inbox-toolbar-right">
          <button
            className="action-btn secondary"
            onClick={() => void saveCurrentView()}
            style={{ padding: '7px 14px' }}
            title="Save current account, folder, and search as a named view (shortcuts appear below)"
          >
            <i className="fas fa-bookmark"></i>
          </button>
          <div className="search-box" style={{ width: '260px' }}>
            <i className="fas fa-search"></i>
            <input
              type="text"
              placeholder="Search emails..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
            />
          </div>
        </div>
      </div>

      <div
        className="inbox-export-panel"
        style={{
          marginBottom: 12,
          border: '1px solid var(--border-subtle, #e5e7eb)',
          borderRadius: 10,
          overflow: 'hidden',
          minWidth: 0,
        }}
      >
        <button
          type="button"
          onClick={() => setExportOpen(o => !o)}
          className="action-btn secondary"
          style={{
            width: '100%',
            borderRadius: 0,
            justifyContent: 'space-between',
            display: 'flex',
            alignItems: 'center',
            border: 'none',
            background: 'var(--surface-elevated, #f9fafb)',
          }}
        >
          <span>
            <i className="fas fa-file-export" style={{ marginRight: 8 }} />
            Export mail (CSV / TXT)
          </span>
          <i className={`fas fa-chevron-${exportOpen ? 'up' : 'down'}`} />
        </button>
        {exportOpen && selectedAccount && (
          <div
            style={{
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              fontSize: 13,
              minWidth: 0,
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
              <span style={{ color: '#6b7280', marginRight: 4 }}>Scope</span>
              <select
                className="inbox-account-select"
                value={exportScope}
                onChange={e => setExportScope(e.target.value as EmailExportScope)}
                style={{ minWidth: 220 }}
              >
                <option value="current_folder">Current folder (this mailbox)</option>
                <option value="all_folders_account">All folders — this mailbox only</option>
                <option value="selected_accounts_all_folders">All folders — selected mailboxes</option>
                <option value="all_token_accounts">All folders — every active token mailbox</option>
              </select>
            </div>
            {exportScope === 'selected_accounts_all_folders' && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className="action-btn secondary"
                  style={{ fontSize: 11, padding: '4px 10px' }}
                  onClick={() => setExportAccountIds(new Set(accounts.map(a => a.id)))}
                >
                  All listed
                </button>
                <button
                  type="button"
                  className="action-btn secondary"
                  style={{ fontSize: 11, padding: '4px 10px' }}
                  onClick={() => setExportAccountIds(new Set())}
                >
                  Clear
                </button>
                {accounts.map(a => (
                  <label key={a.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={exportAccountIds.has(a.id)}
                      onChange={() => toggleExportAccount(a.id)}
                    />
                    <span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.email}</span>
                  </label>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                Format
                <select
                  className="inbox-account-select"
                  value={exportFormat}
                  onChange={e => setExportFormat(e.target.value as ExportFormat)}
                >
                  <option value="csv">CSV</option>
                  <option value="txt">TXT</option>
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                Max / folder
                <input
                  type="number"
                  className="inbox-account-select"
                  style={{ width: 90 }}
                  min={50}
                  max={50000}
                  value={exportMaxPerFolder}
                  onChange={e => setExportMaxPerFolder(parseInt(e.target.value, 10) || 2000)}
                />
              </label>
            </div>
            <div className="search-box" style={{ maxWidth: 400 }}>
              <i className="fas fa-filter" />
              <input
                type="text"
                placeholder="Optional: From address / name contains…"
                value={exportFromFilter}
                onChange={e => setExportFromFilter(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
              <button
                type="button"
                className="action-btn"
                disabled={exportBusy}
                onClick={() => void runExport()}
              >
                {exportBusy ? <i className="fas fa-spinner fa-spin" /> : <i className="fas fa-download" />}
                <span style={{ marginLeft: 8 }}>{exportBusy ? 'Exporting…' : 'Download…'}</span>
              </button>
              {exportStatus && (
                <span style={{ color: '#6b7280', fontSize: 12, flex: '1 1 200px', minWidth: 0 }}>{exportStatus}</span>
              )}
            </div>
            <p style={{ margin: 0, fontSize: 12, color: '#9ca3af', lineHeight: 1.45 }}>
              Large exports paginate the mailbox and may take a while. CSV is spreadsheet-friendly; TXT uses one block per
              message (preview text only, not full HTML bodies).
            </p>
          </div>
        )}
      </div>

      {error && (
        <div style={{ padding: '12px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, color: '#dc2626', fontSize: 13, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
          <i className="fas fa-exclamation-triangle"></i>
          <div style={{ flex: 1 }}>
            {error}
            {error.includes('REFRESH_TOKEN_EXPIRED') && (
              <div style={{ marginTop: 4, fontSize: 12, color: '#991b1b' }}>
                The token for this account has expired. Go to <strong>Accounts</strong> and re-authenticate to get a fresh token.
              </div>
            )}
          </div>
        </div>
      )}

      {savedViews.length > 0 && (
        <div style={{ marginBottom: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {savedViews.map(v => (
            <span
              key={v.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: '#eef2ff',
                color: '#3730a3',
                borderRadius: 999,
                padding: '4px 10px',
                fontSize: 12,
              }}
            >
              <button
                type="button"
                style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer' }}
                onClick={() => void applySavedView(v.id)}
                title="Apply saved view"
              >
                {v.name}
              </button>
              <button
                type="button"
                style={{ border: 0, background: 'transparent', color: '#4338ca', cursor: 'pointer' }}
                onClick={() => void deleteSavedView(v.id)}
                title="Delete saved view"
              >
                <i className="fas fa-times"></i>
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Main: list + reader */}
      <div className="inbox-main">
        {/* Email List */}
        <div className="inbox-list">
          <div className="inbox-list-header">
            <span>{loadingMessages ? 'Loading...' : `${messages.length} emails`}</span>
          </div>
          <div className="inbox-list-body">
            {messages.map(msg => {
              const hit = msg.id ? monitorHits[msg.id] : undefined;
              const rep = matchReputation(reputationEntries, msg.from?.emailAddress?.address);
              const rowClass = [
                'inbox-email-row',
                selectedMsg?.id === msg.id ? 'selected' : '',
                hit ? 'inbox-email-row--monitor-hit' : '',
                hit && !hit.read ? 'inbox-email-row--monitor-hit-unread' : '',
                rep?.list === 'blacklist' ? 'inbox-email-row--rep-blacklist' : '',
                rep?.list === 'whitelist' ? 'inbox-email-row--rep-whitelist' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
              <div
                key={msg.id}
                className={rowClass}
                onClick={() => handleSelectMessage(msg)}
              >
                <div className="inbox-email-left">
                  <div className="inbox-email-avatar">
                    {(msg.from?.emailAddress?.address || '?')[0].toUpperCase()}
                  </div>
                </div>
                <div className="inbox-email-content">
                  <div className="inbox-email-top">
                    <span className="inbox-email-sender bold">
                      {msg.from?.emailAddress?.address || 'Unknown'}
                    </span>
                    <span className="inbox-email-time">{formatTime(msg.receivedDateTime)}</span>
                  </div>
                  <div className="inbox-email-subject bold">{msg.subject || '(no subject)'}</div>
                  <div className="inbox-email-preview">{msg.bodyPreview || ''}</div>
                  <div className="inbox-email-meta">
                    <span className="inbox-domain-tag" style={{ borderColor: '#6b7280', color: '#6b7280' }}>
                      {getDomainFromEmail(msg.from?.emailAddress?.address)}
                    </span>
                    {hit && (
                      <span className="inbox-monitor-badge" title={hit.keywords.join(', ')}>
                        {hit.keywords[0]}
                        {hit.keywords.length > 1 ? ` +${hit.keywords.length - 1}` : ''}
                      </span>
                    )}
                    {rep && (
                      <span
                        className="inbox-rep-badge"
                        title={rep.note || (rep.list === 'whitelist' ? 'Whitelisted' : 'Blacklisted')}
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: rep.list === 'whitelist' ? '#d1fae5' : '#fee2e2',
                          color: rep.list === 'whitelist' ? '#065f46' : '#991b1b',
                        }}
                      >
                        {rep.list === 'whitelist' ? 'TRUSTED' : 'BLOCKED'}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              );
            })}
            {!loadingMessages && messages.length === 0 && (
              <div className="inbox-empty">
                <i className="fas fa-inbox"></i>
                <p>No messages found</p>
              </div>
            )}
            {messageMode === 'folder' && messageNextLink && (
              <div className="inbox-load-more">
                <button
                  type="button"
                  className="action-btn secondary"
                  onClick={() => void loadMoreMessages()}
                  disabled={loadingMoreMessages}
                >
                  {loadingMoreMessages ? (
                    <i className="fas fa-spinner fa-spin"></i>
                  ) : (
                    <i className="fas fa-chevron-down"></i>
                  )}
                  <span style={{ marginLeft: 8 }}>{loadingMoreMessages ? 'Loading...' : 'Load more emails'}</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Reader */}
        <div className="inbox-reader">
          {selectedMsg ? (
            <>
              <div className="inbox-reader-header">
                <div className="inbox-reader-subject">{selectedMsg.subject || '(no subject)'}</div>
                <div className="inbox-reader-actions">
                  <button className="icon-btn" title="Reply" onClick={() => setShowReplyBox(!showReplyBox)}>
                    <i className="fas fa-reply"></i>
                  </button>
                  {selectedMsg.webLink && (
                    <button className="icon-btn" title="Open in Outlook" onClick={() => window.electron.browser.open(selectedMsg.webLink!)}>
                      <i className="fas fa-external-link-alt"></i>
                    </button>
                  )}
                  {showTranslation ? (
                    <button
                      className="icon-btn"
                      title="Show original"
                      onClick={() => setShowTranslation(false)}
                    >
                      <i className="fas fa-undo"></i>
                    </button>
                  ) : (
                    <button
                      className="icon-btn"
                      title={translating ? 'Translating…' : 'Translate body'}
                      onClick={() => void handleTranslateBody()}
                      disabled={translating || loadingBody}
                    >
                      <i className={`fas ${translating ? 'fa-spinner fa-spin' : 'fa-language'}`}></i>
                    </button>
                  )}
                </div>
              </div>
              <div className="inbox-reader-meta">
                <div className="inbox-reader-from">
                  <div className="inbox-reader-avatar">
                    {(selectedMsg.from?.emailAddress?.address || '?')[0].toUpperCase()}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div className="inbox-reader-from-name">{selectedMsg.from?.emailAddress?.address || 'Unknown'}</div>
                    <div className="inbox-reader-from-email">{formatTime(selectedMsg.receivedDateTime)}</div>
                    {selectedMsg.from?.emailAddress?.address && (
                      <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        <button
                          type="button"
                          className="action-btn secondary"
                          style={{ padding: '6px 12px', fontSize: 12 }}
                          onClick={() =>
                            void addReputationEntry({
                              value: selectedMsg.from!.emailAddress!.address!,
                              type: 'sender',
                              list: 'whitelist',
                              note: 'From Central Inbox',
                            })
                          }
                        >
                          <i className="fas fa-check-circle" style={{ color: '#059669' }}></i> Trust sender
                        </button>
                        <button
                          type="button"
                          className="action-btn secondary"
                          style={{ padding: '6px 12px', fontSize: 12 }}
                          onClick={() =>
                            void addReputationEntry({
                              value: selectedMsg.from!.emailAddress!.address!,
                              type: 'sender',
                              list: 'blacklist',
                              note: 'From Central Inbox',
                            })
                          }
                        >
                          <i className="fas fa-ban" style={{ color: '#dc2626' }}></i> Block sender
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="inbox-reader-body">
                {loadingBody ? (
                  <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>
                    <i className="fas fa-spinner fa-spin" style={{ fontSize: 24 }}></i>
                    <p style={{ marginTop: 8 }}>Loading email body...</p>
                  </div>
                ) : showTranslation && translations[selectedMsg.id] ? (
                  <>
                    <div
                      style={{
                        fontSize: 12,
                        color: '#6b7280',
                        marginBottom: 12,
                        padding: '6px 10px',
                        background: '#f3f4f6',
                        borderRadius: 6,
                        display: 'inline-block',
                      }}
                    >
                      <i className="fas fa-language" style={{ marginRight: 6 }} />
                      Translated
                      {translations[selectedMsg.id].sourceLang
                        ? ` from ${translations[selectedMsg.id].sourceLang}`
                        : ''}
                    </div>
                    <pre
                      style={{
                        whiteSpace: 'pre-wrap',
                        fontFamily: 'inherit',
                        fontSize: 14,
                        lineHeight: 1.5,
                        margin: 0,
                      }}
                    >
                      {translations[selectedMsg.id].text}
                    </pre>
                  </>
                ) : (
                  <div dangerouslySetInnerHTML={{ __html: msgBody }}></div>
                )}
                {translationError && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: 10,
                      background: '#fef2f2',
                      border: '1px solid #fecaca',
                      borderRadius: 6,
                      color: '#dc2626',
                      fontSize: 13,
                    }}
                  >
                    <i className="fas fa-exclamation-triangle" style={{ marginRight: 6 }} />
                    {translationError}
                  </div>
                )}
              </div>
              {showReplyBox && (
                <div className="inbox-reply-box">
                  <div className="inbox-reply-header">
                    <i className="fas fa-reply"></i> Reply to {selectedMsg.from?.emailAddress?.address}
                  </div>
                  <textarea
                    className="inbox-reply-textarea"
                    placeholder="Type your reply..."
                    value={replyText}
                    onChange={e => setReplyText(e.target.value)}
                    rows={5}
                  />
                  <div className="inbox-reply-actions">
                    <button className="action-btn primary" style={{ padding: '8px 20px' }}>
                      <i className="fas fa-paper-plane"></i> Send Reply
                    </button>
                    <button className="action-btn secondary" style={{ padding: '8px 16px' }} onClick={() => setShowReplyBox(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="inbox-reader-empty">
              <i className="fas fa-envelope-open-text"></i>
              <h3>Select an email to read</h3>
              <p>Choose an email from the list to view its contents</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CentralInboxView;
