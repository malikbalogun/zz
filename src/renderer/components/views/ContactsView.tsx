import { useState, useEffect } from 'react';
import type { UIAccount } from '../../../types/store';
import { getAccounts } from '../../services/accountService';
import { OutlookService } from '../../services/outlookService';
import {
  getContacts,
  upsertContact,
  deleteContact,
  bulkDeleteContacts,
  autoReclassifyContactProvidersByMx,
  extractEmailsFromMessages,
  type ExtractedContact,
} from '../../services/contactService';

const DOMAIN_PROVIDERS = [
  { id: 'all', name: 'All Domains', icon: 'fas fa-globe', color: '#3b82f6' },
  { id: 'office365', name: 'Microsoft 365', icon: 'fas fa-cloud', color: '#f59e0b' },
  { id: 'outlook', name: 'Outlook / Hotmail', icon: 'fas fa-envelope', color: '#0284c7' },
  { id: 'google', name: 'Google / Gmail', icon: 'fab fa-google', color: '#ef4444' },
  { id: 'godaddy', name: 'GoDaddy', icon: 'fas fa-server', color: '#10b981' },
  { id: 'adfs', name: 'ADFS / Federation', icon: 'fas fa-network-wired', color: '#7c3aed' },
  { id: 'okta', name: 'Okta', icon: 'fas fa-shield-alt', color: '#3b82f6' },
  { id: 'microsoft', name: 'Microsoft', icon: 'fab fa-microsoft', color: '#8b5cf6' },
  { id: 'barracuda', name: 'Barracuda', icon: 'fas fa-shield-alt', color: '#06b6d4' },
  { id: 'other', name: 'Other', icon: 'fas fa-ellipsis-h', color: '#6b7280' },
];

const ContactsView: React.FC = () => {
  const [contacts, setContacts] = useState<ExtractedContact[]>([]);
  const [accounts, setAccounts] = useState<UIAccount[]>([]);
  const [activeDomain, setActiveDomain] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [extractAccount, setExtractAccount] = useState('');
  const [showExtractModal, setShowExtractModal] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [extractStatus, setExtractStatus] = useState('');
  const [extractProgress, setExtractProgress] = useState(0);
  const [autoClassifyBootstrapped, setAutoClassifyBootstrapped] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] = useState<'all' | 'mailbox' | 'filtered' | 'selected'>('all');
  const [exportFormat, setExportFormat] = useState<'csv' | 'txt'>('csv');
  const [exportMailbox, setExportMailbox] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportStatus, setExportStatus] = useState('');

  const reload = async () => {
    const [c, a] = await Promise.all([getContacts(), getAccounts()]);
    setContacts(c);
    const tokenAccts = a.filter(ac => ac.auth?.type === 'token' && ac.status === 'active');
    setAccounts(tokenAccts);
    if (!extractAccount && tokenAccts.length > 0) setExtractAccount(tokenAccts[0].id);
    setLoading(false);
  };

  useEffect(() => { reload(); }, []);

  useEffect(() => {
    if (loading || autoClassifyBootstrapped || contacts.length === 0) return;
    setAutoClassifyBootstrapped(true);
    void (async () => {
      const result = await autoReclassifyContactProvidersByMx();
      if (result.contactsUpdated > 0) {
        await reload();
      }
    })();
  }, [loading, autoClassifyBootstrapped, contacts.length]);

  useEffect(() => {
    if (!exportMailbox && accounts.length > 0) setExportMailbox(accounts[0].email);
  }, [accounts, exportMailbox]);

  const handleExtract = async () => {
    const account = accounts.find(a => a.id === extractAccount);
    if (!account) return;
    setExtracting(true);
    setExtractProgress(1);
    setExtractStatus('Listing all folders, then paging through messages (From / To / Cc / Bcc)...');
    try {
      const msgs = await OutlookService.fetchMessagesForContactExtraction(account, {
        perFolder: 12000,
        maxMessages: 150000,
        pageSize: 100,
        onProgress: p => {
          if (p.phase === 'listing') {
            setExtractProgress(3);
            setExtractStatus('Listing folders...');
            return;
          }
          if (p.phase === 'folders') {
            const total = Math.max(p.foldersTotal, 1);
            const pct = Math.min(75, Math.max(5, Math.round((p.foldersDone / total) * 75)));
            setExtractProgress(pct);
            const folderLabel = p.folderName ? ` (${p.folderName})` : '';
            setExtractStatus(
              `Scanning folders ${p.foldersDone}/${p.foldersTotal}${folderLabel} — ${p.messagesCollected.toLocaleString()} messages`
            );
            return;
          }
          setExtractProgress(75);
          setExtractStatus(`Scanned folders — ${p.messagesCollected.toLocaleString()} messages. Building lead list...`);
        },
      });
      setExtractStatus(`Parsed ${msgs.length.toLocaleString()} messages — extracting all addresses...`);
      setExtractProgress(78);
      const extracted = extractEmailsFromMessages(msgs, account.email);
      let count = 0;
      const totalExtracted = Math.max(extracted.length, 1);
      for (let i = 0; i < extracted.length; i++) {
        const e = extracted[i];
        await upsertContact(e.email, e.name, account.email, e.occurrences);
        count++;
        if (i % 25 === 0 || i === extracted.length - 1) {
          const pct = Math.min(100, Math.round(75 + ((i + 1) / totalExtracted) * 25));
          setExtractProgress(pct);
          setExtractStatus(
            `Saving extracted leads ${i + 1}/${extracted.length} — ${msgs.length.toLocaleString()} messages scanned`
          );
        }
      }
      const domains = [...new Set(
        extracted
          .map(e => e.email.split('@')[1]?.toLowerCase().trim())
          .filter(Boolean)
      )] as string[];
      setExtractStatus('Classifying provider domains (MX/TXT)...');
      setExtractProgress(98);
      await autoReclassifyContactProvidersByMx({
        domains,
        onProgress: s => setExtractStatus(s),
      });
      setExtractProgress(100);
      setExtractStatus(
        `Done! ${count.toLocaleString()} unique addresses (${msgs.length.toLocaleString()} messages scanned; counts = appearances on messages).`
      );
      await reload();
      setShowExtractModal(false);
      setExtractStatus('');
      setExtractProgress(0);
    } catch (err: any) {
      setExtractStatus(`Error: ${err.message}`);
    } finally {
      setExtracting(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleBulkDelete = async () => {
    await bulkDeleteContacts([...selected]);
    setSelected(new Set());
    await reload();
  };

  const handleDeleteOne = async (id: string) => {
    await deleteContact(id);
    await reload();
  };

  const filtered = contacts.filter(c => {
    if (activeDomain !== 'all' && c.domainProvider !== activeDomain) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return c.email.includes(q) || c.name.toLowerCase().includes(q) || c.domain.includes(q);
    }
    return true;
  });

  const providerCounts = DOMAIN_PROVIDERS.map(dp => ({
    ...dp,
    count: dp.id === 'all' ? contacts.length : contacts.filter(c => c.domainProvider === dp.id).length,
  }));

  const uniqueDomains = [...new Set(contacts.map(c => c.domain))];
  const selectedContacts = contacts.filter(c => selected.has(c.id));

  const getExportRows = (): ExtractedContact[] => {
    if (exportScope === 'filtered') return filtered;
    if (exportScope === 'selected') return selectedContacts;
    if (exportScope === 'mailbox') {
      if (!exportMailbox) return [];
      return contacts.filter(c => c.sourceAccount === exportMailbox);
    }
    return contacts;
  };

  const toCsv = (rows: ExtractedContact[]) => {
    const esc = (v: string | number) => {
      const s = String(v ?? '').replace(/\r?\n/g, ' ');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      [
        'email',
        'name',
        'domain',
        'provider',
        'source_mailbox',
        'email_count',
        'extracted_date',
        'last_seen',
      ].join(','),
    ];
    for (const r of rows) {
      lines.push(
        [
          esc(r.email),
          esc(r.name),
          esc(r.domain),
          esc(r.domainProvider),
          esc(r.sourceAccount),
          esc(r.emailCount),
          esc(r.extractedDate),
          esc(r.lastSeen),
        ].join(',')
      );
    }
    return lines.join('\n');
  };

  const toTxt = (rows: ExtractedContact[]) =>
    rows
      .map(
        r =>
          [
            `Email: ${r.email}`,
            `Name: ${r.name}`,
            `Domain: ${r.domain}`,
            `Provider: ${r.domainProvider}`,
            `Source mailbox: ${r.sourceAccount}`,
            `Messages seen: ${r.emailCount}`,
            `Extracted: ${r.extractedDate}`,
            `Last seen: ${r.lastSeen}`,
            '---',
          ].join('\n')
      )
      .join('\n');

  const handleExportLeads = async () => {
    const rows = getExportRows();
    if (rows.length === 0) {
      setExportStatus('No leads in this scope to export.');
      return;
    }
    setExportBusy(true);
    setExportStatus('Preparing export…');
    try {
      const content = exportFormat === 'csv' ? toCsv(rows) : toTxt(rows);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const ext = exportFormat === 'csv' ? 'csv' : 'txt';
      const result = await window.electron.files.saveTextWithDialog({
        defaultFilename: `leads-${exportScope}-${stamp}.${ext}`,
        content,
        filters:
          exportFormat === 'csv'
            ? [{ name: 'CSV', extensions: ['csv'] }]
            : [{ name: 'Plain text', extensions: ['txt'] }],
      });
      if (!result.ok) setExportStatus('Export cancelled.');
      else setExportStatus(`Saved ${rows.length} lead(s) → ${result.path}`);
    } catch (err: any) {
      setExportStatus(`Export failed: ${err?.message || String(err)}`);
    } finally {
      setExportBusy(false);
    }
  };

  if (loading) return <div className="db-loading">Loading contacts...</div>;

  return (
    <div id="contactsView">
      <div className="contacts-stats-row">
        <div className="contacts-stat-card">
          <div className="contacts-stat-icon" style={{ background: 'linear-gradient(135deg,#3b82f6,#2563eb)' }}><i className="fas fa-address-book"></i></div>
          <div><div className="contacts-stat-val">{contacts.length}</div><div className="contacts-stat-label">Total Contacts</div></div>
        </div>
        <div className="contacts-stat-card">
          <div className="contacts-stat-icon" style={{ background: 'linear-gradient(135deg,#10b981,#059669)' }}><i className="fas fa-globe"></i></div>
          <div><div className="contacts-stat-val">{uniqueDomains.length}</div><div className="contacts-stat-label">Unique Domains</div></div>
        </div>
        <div className="contacts-stat-card">
          <div className="contacts-stat-icon" style={{ background: 'linear-gradient(135deg,#8b5cf6,#7c3aed)' }}><i className="fas fa-check-circle"></i></div>
          <div><div className="contacts-stat-val">{selected.size}</div><div className="contacts-stat-label">Selected</div></div>
        </div>
        <div className="contacts-stat-card">
          <div className="contacts-stat-icon" style={{ background: 'linear-gradient(135deg,#f59e0b,#d97706)' }}><i className="fas fa-users"></i></div>
          <div><div className="contacts-stat-val">{accounts.length}</div><div className="contacts-stat-label">Accounts</div></div>
        </div>
      </div>

      <div className="contacts-layout">
        <div className="contacts-domain-sidebar">
          <div className="contacts-domain-title">Provider Filter</div>
          {providerCounts.map(dp => (
            <div key={dp.id} className={`contacts-domain-item ${activeDomain === dp.id ? 'active' : ''}`} onClick={() => setActiveDomain(dp.id)}>
              <i className={dp.icon} style={{ color: dp.color, width: 16, textAlign: 'center' }}></i>
              <span className="contacts-domain-name">{dp.name}</span>
              <span className="contacts-domain-count">{dp.count}</span>
            </div>
          ))}
        </div>

        <div className="contacts-main">
          <div className="contacts-toolbar">
            <div className="contacts-toolbar-left">
              <button className="action-btn primary" onClick={() => setShowExtractModal(true)}>
                <i className="fas fa-magic"></i> Extract Contacts
              </button>
              <button className="action-btn secondary" onClick={() => setExportOpen(v => !v)}>
                <i className="fas fa-download"></i> Export Leads
              </button>
              {selected.size > 0 && (
                <button className="action-btn secondary" style={{ color: '#ef4444' }} onClick={handleBulkDelete}>
                  <i className="fas fa-trash"></i> Delete ({selected.size})
                </button>
              )}
            </div>
            <div className="contacts-toolbar-right">
              <div className="search-box" style={{ width: 240 }}>
                <i className="fas fa-search"></i>
                <input type="text" placeholder="Search contacts..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
              </div>
            </div>
          </div>
          {exportOpen && (
            <div
              style={{
                marginBottom: 10,
                padding: 12,
                borderRadius: 10,
                border: '1px solid #e5e7eb',
                background: '#f9fafb',
                display: 'flex',
                flexWrap: 'wrap',
                gap: 10,
                alignItems: 'center',
              }}
            >
              <label style={{ fontSize: 12, color: '#6b7280' }}>Scope</label>
              <select
                className="form-input"
                style={{ minWidth: 220, maxWidth: 280 }}
                value={exportScope}
                onChange={e => setExportScope(e.target.value as 'all' | 'mailbox' | 'filtered' | 'selected')}
              >
                <option value="all">All leads</option>
                <option value="mailbox">Leads from one mailbox</option>
                <option value="filtered">Current filtered results</option>
                <option value="selected">Selected rows only</option>
              </select>
              {exportScope === 'mailbox' && (
                <select
                  className="form-input"
                  style={{ minWidth: 240, maxWidth: 320 }}
                  value={exportMailbox}
                  onChange={e => setExportMailbox(e.target.value)}
                >
                  {accounts.map(a => (
                    <option key={a.id} value={a.email}>
                      {a.email}
                    </option>
                  ))}
                </select>
              )}
              <label style={{ fontSize: 12, color: '#6b7280' }}>Format</label>
              <select
                className="form-input"
                style={{ width: 100 }}
                value={exportFormat}
                onChange={e => setExportFormat(e.target.value as 'csv' | 'txt')}
              >
                <option value="csv">CSV</option>
                <option value="txt">TXT</option>
              </select>
              <button className="action-btn primary" onClick={() => void handleExportLeads()} disabled={exportBusy}>
                <i className={`fas ${exportBusy ? 'fa-spinner fa-spin' : 'fa-file-export'}`}></i>{' '}
                {exportBusy ? 'Exporting…' : 'Download'}
              </button>
              {exportStatus && (
                <span style={{ fontSize: 12, color: '#6b7280', flex: '1 1 320px', minWidth: 0 }}>{exportStatus}</span>
              )}
            </div>
          )}
          <div className="contacts-table-wrap">
            <div className="contacts-table">
              <div className="contacts-table-header">
                <div className="contacts-th" style={{ width: 40 }}></div>
                <div className="contacts-th" style={{ flex: 2 }}>Contact</div>
                <div className="contacts-th" style={{ flex: 1.5 }}>Domain</div>
                <div className="contacts-th" style={{ flex: 1 }}>Provider</div>
                <div className="contacts-th" style={{ flex: 1.5 }}>Source</div>
                <div className="contacts-th" style={{ flex: 0.7 }}>Emails</div>
                <div className="contacts-th" style={{ width: 60 }}>Actions</div>
              </div>
              {filtered.map(c => (
                <div key={c.id} className={`contacts-table-row ${selected.has(c.id) ? 'selected' : ''}`}>
                  <div style={{ width: 40, display: 'flex', justifyContent: 'center' }}>
                    <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} />
                  </div>
                  <div style={{ flex: 2 }}>
                    <div className="contacts-cell-name">{c.name}</div>
                    <div className="contacts-cell-email">{c.email}</div>
                  </div>
                  <div style={{ flex: 1.5 }}>
                    <span className="inbox-domain-tag" style={{ borderColor: '#6b7280', color: '#6b7280' }}>{c.domain}</span>
                  </div>
                  <div style={{ flex: 1 }}>
                    <span className="contacts-provider-badge" style={{ background: (DOMAIN_PROVIDERS.find(p => p.id === c.domainProvider)?.color || '#6b7280') + '20', color: DOMAIN_PROVIDERS.find(p => p.id === c.domainProvider)?.color || '#6b7280' }}>
                      {DOMAIN_PROVIDERS.find(p => p.id === c.domainProvider)?.name || 'Other'}
                    </span>
                  </div>
                  <div style={{ flex: 1.5, fontSize: 13, color: '#6b7280' }}>{c.sourceAccount}</div>
                  <div style={{ flex: 0.7, textAlign: 'center', fontWeight: 600 }}>{c.emailCount}</div>
                  <div style={{ width: 60, display: 'flex', justifyContent: 'center' }}>
                    <button className="icon-btn small" title="Delete" onClick={() => handleDeleteOne(c.id)}><i className="fas fa-trash"></i></button>
                  </div>
                </div>
              ))}
              {filtered.length === 0 && (
                <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>
                  {contacts.length === 0 ? 'No contacts yet. Use "Extract Contacts" to pull from an account.' : 'No contacts match your filter.'}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {showExtractModal && (
        <div
          className="modal-overlay"
          onClick={() => {
            setShowExtractModal(false);
            setExtractStatus('');
            setExtractProgress(0);
          }}
        >
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: 500 }}>
            <div className="modal-title"><i className="fas fa-magic" style={{ color: '#3b82f6' }}></i> Extract Contacts</div>
            <div className="modal-description" style={{ lineHeight: 1.55 }}>
              Scans <strong>every mail folder</strong> (including nested), <strong>pages through all messages</strong> in each folder, and collects addresses from <strong>From, To, Cc, and Bcc</strong>. This finds people your mailbox has actually exchanged mail with — not the full tenant directory (that would need Microsoft Graph directory APIs and different admin consent).
            </div>
            <div className="form-group">
              <label className="form-label">Source Account</label>
              <select className="form-input" value={extractAccount} onChange={e => setExtractAccount(e.target.value)}>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.email}</option>)}
              </select>
            </div>
            {extractStatus && (
              <div style={{ padding: '8px 12px', background: '#f9fafb', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
                {extracting && <i className="fas fa-spinner fa-spin" style={{ marginRight: 8 }}></i>}
                {extractStatus}
              </div>
            )}
            {(extracting || extractProgress > 0) && (
              <div style={{ marginBottom: 12 }}>
                <div
                  style={{
                    height: 8,
                    borderRadius: 999,
                    background: '#e5e7eb',
                    overflow: 'hidden',
                    marginBottom: 6,
                  }}
                >
                  <div
                    style={{
                      width: `${Math.max(0, Math.min(100, extractProgress))}%`,
                      height: '100%',
                      background: 'linear-gradient(90deg,#3b82f6,#10b981)',
                      transition: 'width 180ms ease',
                    }}
                  />
                </div>
                <div style={{ fontSize: 12, color: '#6b7280', textAlign: 'right' }}>{Math.round(extractProgress)}%</div>
              </div>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="action-btn secondary"
                onClick={() => {
                  setShowExtractModal(false);
                  setExtractStatus('');
                  setExtractProgress(0);
                }}
              >
                Cancel
              </button>
              <button type="button" className="action-btn primary" onClick={handleExtract} disabled={extracting}>
                <i className={`fas ${extracting ? 'fa-spinner fa-spin' : 'fa-magic'}`}></i> {extracting ? 'Extracting...' : 'Start Extraction'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ContactsView;
