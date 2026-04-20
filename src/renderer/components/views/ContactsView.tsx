import { useState, useEffect, useMemo } from 'react';
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
  const [sourceFilterAccount, setSourceFilterAccount] = useState('');
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [extractAccount, setExtractAccount] = useState('');
  const [extractAccountSearch, setExtractAccountSearch] = useState('');
  const [extractDropdownOpen, setExtractDropdownOpen] = useState(false);

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

  // Close the searchable extract-account dropdown when the user clicks outside.
  useEffect(() => {
    if (!extractDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.extract-account-dropdown-container')) {
        setExtractDropdownOpen(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [extractDropdownOpen]);

  // Reset the search filter whenever the dropdown closes.
  useEffect(() => {
    if (!extractDropdownOpen) {
      setExtractAccountSearch('');
    }
  }, [extractDropdownOpen]);

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
      setExtractStatus('');
      setExtractProgress(0);
    } catch (err: any) {
      setExtractStatus(`Error: ${err.message}`);
    } finally {
      setExtracting(false);
    }
  };

  const handleReset = () => {
    setContacts([]);
    setSelected(new Set());
    setExtractStatus('');
    setExtractProgress(0);
    setSearchQuery('');
    setSourceFilterAccount('');
    setActiveDomain('all');
    setExtractAccount('');
    setExportOpen(false);
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

  const sourceAccounts = useMemo(() => [...new Set(contacts.map(c => c.sourceAccount))], [contacts]);

  const filtered = contacts.filter(c => {
    if (activeDomain !== 'all' && c.domainProvider !== activeDomain) return false;
    if (sourceFilterAccount && c.sourceAccount !== sourceFilterAccount) return false;
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
      {/* Extraction Control */}
      <div className="extraction-control">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ flex: 1, position: 'relative' }} className="extract-account-dropdown-container">
            <label className="form-label" style={{ marginBottom: 6 }}>Extract Contacts From Account</label>
            <button
              type="button"
              className="form-input"
              style={{
                textAlign: 'left',
                width: '100%',
                marginBottom: 8,
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
              onClick={() => setExtractDropdownOpen(!extractDropdownOpen)}
              disabled={extracting}
              aria-expanded={extractDropdownOpen}
              aria-haspopup="listbox"
              aria-label="Select an account to extract contacts from"
            >
              <span>
                {extractAccount
                  ? accounts.find(a => a.id === extractAccount)?.email
                  : 'Select an account...'}
              </span>
              <i className={`fas ${extractDropdownOpen ? 'fa-chevron-up' : 'fa-chevron-down'}`} />
            </button>
            {extractDropdownOpen && (
              <div
                className="extract-dropdown"
                role="listbox"
                aria-label="Account selection"
                style={{
                  position: 'absolute',
                  zIndex: 1000,
                  backgroundColor: '#fff',
                  border: '1px solid #d1d5db',
                  borderRadius: 6,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                  width: '100%',
                  maxHeight: 300,
                  overflow: 'auto',
                }}
              >
                <input
                  type="text"
                  className="form-input"
                  placeholder="Search accounts..."
                  aria-label="Filter accounts"
                  value={extractAccountSearch}
                  onChange={(e) => setExtractAccountSearch(e.target.value)}
                  style={{
                    border: 0,
                    borderBottom: '1px solid #d1d5db',
                    borderRadius: '6px 6px 0 0',
                    padding: '12px',
                    width: '100%',
                  }}
                  autoFocus
                />
                <div style={{ maxHeight: 250, overflowY: 'auto' }}>
                  {accounts
                    .filter(a =>
                      extractAccountSearch === '' ||
                      a.email.toLowerCase().includes(extractAccountSearch.toLowerCase()) ||
                      a.id === extractAccount
                    )
                    .map(account => (
                      <div
                        key={account.id}
                        role="option"
                        aria-selected={extractAccount === account.id}
                        style={{
                          padding: '10px 12px',
                          cursor: 'pointer',
                          borderBottom: '1px solid #f3f4f6',
                          backgroundColor: extractAccount === account.id ? '#3b82f6' : 'transparent',
                          color: extractAccount === account.id ? '#fff' : '#1f2937',
                        }}
                        onClick={() => {
                          setExtractAccount(account.id);
                          setExtractDropdownOpen(false);
                        }}
                      >
                        {account.email}
                      </div>
                    ))}
                  {accounts.filter(a =>
                    extractAccountSearch === '' ||
                    a.email.toLowerCase().includes(extractAccountSearch.toLowerCase()) ||
                    a.id === extractAccount
                  ).length === 0 && (
                    <div style={{ padding: '12px', color: '#6b7280', textAlign: 'center' }}>
                      No accounts match
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
          <div style={{ alignSelf: 'flex-end', display: 'flex', gap: 8 }}>
            <button
              className="action-btn secondary"
              onClick={handleReset}
              style={{ minWidth: 100, height: 42 }}
            >
              <i className="fas fa-redo"></i> Reset
            </button>
            <button
              className="action-btn primary"
              onClick={handleExtract}
              disabled={extracting || !extractAccount}
              style={{ minWidth: 140, height: 42 }}
            >
              <i className={`fas ${extracting ? 'fa-spinner fa-spin' : 'fa-magic'}`}></i>
              {' '}
              {extracting ? 'Extracting...' : 'Extract Now'}
            </button>
          </div>
        </div>
        {(extracting || extractProgress > 0) && (
          <div style={{ marginTop: 16 }}>
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
            <div style={{ fontSize: 13, color: '#6b7280', display: 'flex', justifyContent: 'space-between' }}>
              <span>{extractStatus}</span>
              <span>{Math.round(extractProgress)}%</span>
            </div>
          </div>
        )}
      </div>

      <div className="contacts-stats-columns">
        <div className="contacts-stats-left">
          <div className="contacts-stat-card provider-filter-card">
            <div className="provider-filter-header">
              <div className="contacts-stat-icon" style={{ background: 'linear-gradient(135deg,#8b5cf6,#7c3aed)' }}><i className="fas fa-filter"></i></div>
              <div className="contacts-stat-label">Provider Filter</div>
            </div>
            <div className="provider-filter-list">
              {providerCounts.map(dp => (
                <div key={dp.id} className={`provider-filter-item ${activeDomain === dp.id ? 'active' : ''}`} onClick={() => setActiveDomain(dp.id)}>
                  <i className={dp.icon} style={{ color: dp.color }}></i>
                  <span className="provider-filter-name">{dp.name}</span>
                  <span className="provider-filter-count">{dp.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="contacts-stats-right">
          <div className="contacts-stat-card">
            <div className="contacts-stat-icon" style={{ background: 'linear-gradient(135deg,#3b82f6,#2563eb)' }}><i className="fas fa-address-book"></i></div>
            <div><div className="contacts-stat-val">{contacts.length}</div><div className="contacts-stat-label">Total Contacts</div></div>
          </div>
          <div className="contacts-stat-card">
            <div className="contacts-stat-icon" style={{ background: 'linear-gradient(135deg,#10b981,#059669)' }}><i className="fas fa-globe"></i></div>
            <div><div className="contacts-stat-val">{uniqueDomains.length}</div><div className="contacts-stat-label">Unique Domains</div></div>
          </div>
        </div>
      </div>

      <div className="contacts-layout">
        <div className="contacts-main">
          <div className="contacts-toolbar">
            <div className="contacts-toolbar-left">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ fontSize: 13, color: '#6b7280' }}>Source:</label>
                <select
                  className="form-input"
                  style={{ width: 200 }}
                  value={sourceFilterAccount}
                  onChange={e => setSourceFilterAccount(e.target.value)}
                >
                  <option value="">All accounts</option>
                  {sourceAccounts.map(email => (
                    <option key={email} value={email}>{email}</option>
                  ))}
                </select>
              </div>
              <button className="action-btn secondary" onClick={() => setExportOpen(v => !v)}>
                <i className="fas fa-download"></i> Export Leads
              </button>
              {selected.size > 0 && (
                <span style={{
                  background: '#3b82f6',
                  color: 'white',
                  fontSize: 10,
                  fontWeight: 'bold',
                  borderRadius: '50%',
                  width: 20,
                  height: 20,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                  marginLeft: -8,
                  marginRight: 4,
                }}>{selected.size}</span>
              )}
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
                <div className="contacts-th" style={{ width: 40, display: 'flex', justifyContent: 'center' }}>
                  <input
                    ref={el => {
                      if (el) {
                        const allOnPage = filtered.length > 0 && filtered.every(c => selected.has(c.id));
                        const someOnPage = !allOnPage && filtered.some(c => selected.has(c.id));
                        el.indeterminate = someOnPage;
                        el.checked = allOnPage;
                      }
                    }}
                    type="checkbox"
                    title={
                      filtered.length === 0
                        ? 'No contacts match the current filter'
                        : filtered.every(c => selected.has(c.id))
                          ? 'Deselect all (visible)'
                          : 'Select all (visible)'
                    }
                    aria-label="Select all visible contacts"
                    disabled={filtered.length === 0}
                    onChange={() => {
                      const allOnPage = filtered.length > 0 && filtered.every(c => selected.has(c.id));
                      setSelected(prev => {
                        const next = new Set(prev);
                        if (allOnPage) {
                          for (const c of filtered) next.delete(c.id);
                        } else {
                          for (const c of filtered) next.add(c.id);
                        }
                        return next;
                      });
                    }}
                  />
                </div>
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


    </div>
  );
};

export default ContactsView;
