import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { UIAccount } from '../../../types/store';
import { getAccounts } from '../../services/accountService';
import { getContacts, type ExtractedContact } from '../../services/contactService';
import { getTemplates, type EmailTemplate } from '../../services/templateService';
import { getOutlookService } from '../../services/outlookService';
import HtmlPreviewModal from '../shared/HtmlPreviewModal';

type ComposerAttachment = { id: string; name: string; contentType: string; base64: string };

type RecipientHygieneOptions = {
  onlySelectedSenderLeads: boolean;
  excludeSameDomain: boolean;
  excludeNoReplyLike: boolean;
  excludeHoneypotLike: boolean;
  excludeRoleBased: boolean;
};

function emailDomain(email: string): string {
  const i = email.lastIndexOf('@');
  return i >= 0 ? email.slice(i + 1).toLowerCase().trim() : '';
}

function isNoReplyLike(localPart: string): boolean {
  return /^(no[\W_]?reply|do[\W_]?not[\W_]?reply|donotreply|noreply|mailer-daemon|postmaster|bounce|bounces|auto(?:mail|reply)?|notification|notifications|alerts?)$/i.test(
    localPart
  );
}

function isRoleBasedMailbox(localPart: string): boolean {
  return /^(admin|administrator|abuse|support|help|info|sales|billing|contact|webmaster|security|compliance|privacy|jobs|careers|hr|it|team|hello|marketing|office|legal)$/i.test(
    localPart
  );
}

function isHoneypotLikeAddress(email: string): boolean {
  return /(trap|honeypot|spamtrap|blackhole|sinkhole)/i.test(email);
}

function buildPreviewSrcDoc(body: string, bodyType: 'html' | 'plain'): string {
  if (bodyType === 'plain') {
    const esc = body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,-apple-system,sans-serif;padding:24px;margin:0;white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.6;color:#374151;}</style></head><body>${esc}</body></html>`;
  }
  const t = body.trim();
  if (/^<!DOCTYPE/i.test(t) || /^<html[\s>]/i.test(t)) return body;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:'Segoe UI',Roboto,sans-serif;padding:24px;margin:0;font-size:14px;line-height:1.6;color:#374151;}</style></head><body>${body}</body></html>`;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const res = r.result;
      if (typeof res !== 'string') {
        reject(new Error('Could not read file'));
        return;
      }
      const comma = res.indexOf(',');
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(file);
  });
}

const EmailComposerView: React.FC = () => {
  const [accounts, setAccounts] = useState<UIAccount[]>([]);
  const [contacts, setContacts] = useState<ExtractedContact[]>([]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  const [sendMode, setSendMode] = useState<'direct' | 'bcc'>('bcc');
  const [selectedSenderEmails, setSelectedSenderEmails] = useState<Set<string>>(new Set());
  const [senderDistribution, setSenderDistribution] = useState<'round_robin' | 'parallel'>('round_robin');
  const [maxParallelSenders, setMaxParallelSenders] = useState(2);
  const [subject, setSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [bodyType, setBodyType] = useState<'html' | 'plain'>('html');
  const [batchSize, setBatchSize] = useState(10);
  const [batchDelay, setBatchDelay] = useState(30);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showTemplates, setShowTemplates] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [hygiene, setHygiene] = useState<RecipientHygieneOptions>({
    onlySelectedSenderLeads: true,
    excludeSameDomain: false,
    excludeNoReplyLike: true,
    excludeHoneypotLike: true,
    excludeRoleBased: true,
  });
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [showInlinePreview, setShowInlinePreview] = useState(false);
  const [showFullPreview, setShowFullPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendMessage, setSendMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [expandedSections, setExpandedSections] = useState({
    recipients: true,
    compose: true,
    settings: false,
  });

  const toggleSection = (key: keyof typeof expandedSections) => {
    setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  useEffect(() => {
    (async () => {
      const [a, c, t] = await Promise.all([getAccounts(), getContacts(), getTemplates()]);
      const tokenAccts = a.filter(ac => ac.auth?.type === 'token' && ac.status === 'active');
      setAccounts(tokenAccts);
      setContacts(c);
      setTemplates(t);
      setSelectedSenderEmails(new Set(tokenAccts.map(ac => ac.email)));
      setSelected(new Set(c.map(ct => ct.id)));
      setLoading(false);
    })();
  }, []);

  const toggleRecipient = (id: string) => {
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const applyTemplate = (t: EmailTemplate) => {
    setSubject(t.subject);
    setEmailBody(t.body);
    setBodyType(t.type);
    setShowTemplates(false);
  };

  const senderDomainSet = useMemo(
    () => new Set(accounts.filter(a => selectedSenderEmails.has(a.email)).map(a => emailDomain(a.email)).filter(Boolean)),
    [accounts, selectedSenderEmails]
  );

  const contactsForSelectedSenders = useMemo(() => {
    if (!hygiene.onlySelectedSenderLeads) return contacts;
    if (selectedSenderEmails.size === 0) return [];
    return contacts.filter(c => selectedSenderEmails.has(c.sourceAccount));
  }, [contacts, hygiene.onlySelectedSenderLeads, selectedSenderEmails]);

  const eligibleContacts = useMemo(() => {
    const out: ExtractedContact[] = [];
    for (const c of contactsForSelectedSenders) {
      const email = c.email.toLowerCase().trim();
      const at = email.lastIndexOf('@');
      if (at <= 0) continue;
      const local = email.slice(0, at);
      const domain = email.slice(at + 1);
      if (hygiene.excludeSameDomain && senderDomainSet.has(domain)) continue;
      if (hygiene.excludeNoReplyLike && isNoReplyLike(local)) continue;
      if (hygiene.excludeHoneypotLike && isHoneypotLikeAddress(email)) continue;
      if (hygiene.excludeRoleBased && isRoleBasedMailbox(local)) continue;
      out.push(c);
    }
    return out;
  }, [contactsForSelectedSenders, hygiene, senderDomainSet]);

  const filteredContacts = useMemo(() => {
    if (!searchFilter) return eligibleContacts;
    const q = searchFilter.toLowerCase();
    return eligibleContacts.filter(c => c.email.includes(q) || c.name.toLowerCase().includes(q) || c.domain.includes(q));
  }, [eligibleContacts, searchFilter]);

  const selectedEligibleCount = useMemo(
    () => eligibleContacts.filter(c => selected.has(c.id)).length,
    [eligibleContacts, selected]
  );

  const previewSrcDoc = useMemo(
    () => buildPreviewSrcDoc(emailBody, bodyType),
    [emailBody, bodyType]
  );

  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    const next: ComposerAttachment[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        const base64 = await readFileAsBase64(f);
        next.push({
          id: crypto.randomUUID(),
          name: f.name,
          contentType: f.type || 'application/octet-stream',
          base64,
        });
      } catch (err) {
        console.warn('[Composer] attachment read failed', f.name, err);
      }
    }
    setAttachments(prev => [...prev, ...next]);
    e.target.value = '';
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  const toggleSenderEmail = (email: string) => {
    setSelectedSenderEmails(prev => {
      const n = new Set(prev);
      if (n.has(email)) n.delete(email);
      else n.add(email);
      return n;
    });
  };

  const handleSend = useCallback(async () => {
    setSendMessage(null);
    const senders = accounts.filter(a => selectedSenderEmails.has(a.email));
    if (!senders.length) {
      setSendMessage({ type: 'err', text: 'Select at least one From mailbox (token-based).' });
      return;
    }
    if (!subject.trim()) {
      setSendMessage({ type: 'err', text: 'Subject is required.' });
      return;
    }
    const picked = eligibleContacts.filter(c => selected.has(c.id));
    if (!picked.length) {
      setSendMessage({ type: 'err', text: 'Select at least one recipient.' });
      return;
    }

    const svc = getOutlookService();
    const att = attachments.map(a => ({
      name: a.name,
      contentType: a.contentType,
      contentBytesBase64: a.base64,
    }));

    const delayMs = Math.max(0, batchDelay) * 1000;
    const parallel = Math.min(5, Math.max(1, maxParallelSenders));

    setSending(true);
    let sent = 0;
    const sendErrors: string[] = [];

    const sendOne = async (acc: UIAccount, to: string[], bcc?: string[]) => {
      await svc.sendNewMessage(acc, {
        subject: subject.trim(),
        body: emailBody,
        bodyIsHtml: bodyType === 'html',
        toRecipients: to,
        bccRecipients: bcc,
        attachments: att.length ? att : undefined,
        saveToSentItems: true,
      });
    };

    try {
      if (sendMode === 'bcc') {
        const emails = picked.map(p => p.email.trim()).filter(Boolean);
        type Row = { acc: UIAccount; chunk: string[] };
        const rows: Row[] = [];
        let sidx = 0;
        for (let i = 0; i < emails.length; i += batchSize) {
          rows.push({
            chunk: emails.slice(i, i + batchSize),
            acc: senders[sidx % senders.length],
          });
          sidx++;
        }
        if (senderDistribution === 'parallel' && rows.length > 1) {
          for (let w = 0; w < rows.length; w += parallel) {
            const wave = rows.slice(w, w + parallel);
            const results = await Promise.allSettled(
              wave.map(({ acc, chunk }) => sendOne(acc, [acc.email], chunk))
            );
            results.forEach((r, j) => {
              if (r.status === 'fulfilled') sent += wave[j].chunk.length;
              else
                sendErrors.push(`${wave[j].acc.email}: ${(r.reason as Error)?.message || r.reason}`);
            });
            if (w + parallel < rows.length && delayMs) await sleep(delayMs);
          }
        } else {
          for (let ri = 0; ri < rows.length; ri++) {
            const { acc, chunk } = rows[ri];
            try {
              await sendOne(acc, [acc.email], chunk);
              sent += chunk.length;
            } catch (e) {
              sendErrors.push(`${acc.email}: ${e instanceof Error ? e.message : String(e)}`);
            }
            if (ri < rows.length - 1 && delayMs) await sleep(delayMs);
          }
        }
      } else {
        type DRow = { acc: UIAccount; email: string };
        const rows: DRow[] = [];
        let sidx = 0;
        for (const p of picked) {
          rows.push({ acc: senders[sidx % senders.length], email: p.email.trim() });
          sidx++;
        }
        if (senderDistribution === 'parallel' && rows.length > 1) {
          for (let w = 0; w < rows.length; w += parallel) {
            const wave = rows.slice(w, w + parallel);
            const results = await Promise.allSettled(wave.map(({ acc, email }) => sendOne(acc, [email])));
            results.forEach((r, j) => {
              if (r.status === 'fulfilled') sent += 1;
              else
                sendErrors.push(`${wave[j].acc.email}→${wave[j].email}: ${(r.reason as Error)?.message || r.reason}`);
            });
            if (w + parallel < rows.length && delayMs) await sleep(delayMs);
          }
        } else {
          for (let i = 0; i < rows.length; i += batchSize) {
            const wave = rows.slice(i, i + batchSize);
            for (const { acc, email } of wave) {
              try {
                await sendOne(acc, [email]);
                sent += 1;
              } catch (e) {
                sendErrors.push(`${acc.email}→${email}: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            if (i + batchSize < rows.length && delayMs) await sleep(delayMs);
          }
        }
      }

      if (sendErrors.length) {
        setSendMessage({
          type: 'err',
          text: `Sent ${sent} message(s); ${sendErrors.length} error(s). ${sendErrors.slice(0, 3).join(' | ')}${sendErrors.length > 3 ? '…' : ''}`,
        });
      } else {
        setSendMessage({
          type: 'ok',
          text: `Sent ${sent} message(s) using ${senders.length} mailbox(es). Check Sent Items if something looks wrong.`,
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setSendMessage({
        type: 'err',
        text: msg.includes('401') || msg.includes('403')
          ? `${msg} — Token may not allow send (Outlook REST Mail.Send).`
          : msg,
      });
    } finally {
      setSending(false);
    }
  }, [
    accounts, selectedSenderEmails, senderDistribution, maxParallelSenders,
    subject, emailBody, bodyType, eligibleContacts, selected,
    sendMode, batchSize, batchDelay, attachments,
  ]);

  if (loading) return <div className="db-loading">Loading composer...</div>;

  if (contacts.length === 0) {
    return (
      <div className="inbox-reader-empty" style={{ height: '60vh' }}>
        <i className="fas fa-address-book"></i>
        <h3>No contacts yet</h3>
        <p>Go to Contacts and extract contacts from an account first, then come back here to compose.</p>
      </div>
    );
  }

  return (
    <div id="emailComposerView">
      {sendMessage && (
        <div
          style={{
            marginBottom: 16,
            padding: '12px 16px',
            borderRadius: 10,
            fontSize: 13,
            background: sendMessage.type === 'ok' ? '#ecfdf5' : '#fef2f2',
            border: `1px solid ${sendMessage.type === 'ok' ? '#a7f3d0' : '#fecaca'}`,
            color: sendMessage.type === 'ok' ? '#065f46' : '#991b1b',
          }}
        >
          {sendMessage.text}
        </div>
      )}

      {/* Stats bar */}
      <div className="composer-stats-bar">
        <div className="composer-stat-card">
          <i className="fas fa-users" style={{ color: '#3b82f6' }}></i>
          <div>
            <div className="composer-stat-val">{eligibleContacts.length}</div>
            <div className="composer-stat-label">Eligible</div>
          </div>
        </div>
        <div className="composer-stat-card">
          <i className="fas fa-check-circle" style={{ color: '#10b981' }}></i>
          <div>
            <div className="composer-stat-val">{selectedEligibleCount}</div>
            <div className="composer-stat-label">Selected</div>
          </div>
        </div>
        <div className="composer-stat-card">
          <i className="fas fa-at" style={{ color: '#ec4899' }}></i>
          <div>
            <div className="composer-stat-val">{selectedSenderEmails.size}</div>
            <div className="composer-stat-label">Senders</div>
          </div>
        </div>
        <div className="composer-stat-card">
          <i className="fas fa-layer-group" style={{ color: '#8b5cf6' }}></i>
          <div>
            <div className="composer-stat-val">{batchSize}</div>
            <div className="composer-stat-label">Batch Size</div>
          </div>
        </div>
        <div className="composer-stat-card">
          <i className="fas fa-file-alt" style={{ color: '#f59e0b' }}></i>
          <div>
            <div className="composer-stat-val">{templates.length}</div>
            <div className="composer-stat-label">Templates</div>
          </div>
        </div>
      </div>

      <div className="composer-layout">
        {/* Section 1: Senders & Recipients */}
        <div className="composer-section">
          <div className="composer-section-header" onClick={() => toggleSection('recipients')}>
            <span className="composer-section-title">
              <i className="fas fa-users"></i> Senders & Recipients
              <span className="section-count">{selectedSenderEmails.size} senders · {selectedEligibleCount} recipients</span>
            </span>
            <i className={`fas fa-chevron-down composer-section-chevron ${expandedSections.recipients ? 'open' : ''}`}></i>
          </div>
          {expandedSections.recipients && (
            <div className="composer-section-body">
              <div className="composer-config-grid">
                {/* Senders column */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <label className="composer-field-label" style={{ margin: 0 }}>From (multi-mailbox)</label>
                    <button
                      type="button"
                      className="action-btn secondary"
                      style={{ fontSize: 11, padding: '4px 10px' }}
                      onClick={() => setSelectedSenderEmails(new Set(accounts.map(a => a.email)))}
                    >
                      All senders
                    </button>
                  </div>
                  <div className="composer-sender-list">
                    {accounts.length === 0 && (
                      <div style={{ color: '#9ca3af', fontSize: 13, padding: 8 }}>No token accounts — add one in Accounts</div>
                    )}
                    {accounts.map(a => (
                      <label key={a.id} className="composer-sender-item">
                        <input type="checkbox" checked={selectedSenderEmails.has(a.email)} onChange={() => toggleSenderEmail(a.email)} />
                        <span>{a.email}</span>
                      </label>
                    ))}
                  </div>

                  <div style={{ marginTop: 12 }}>
                    <label className="composer-field-label">Send Mode</label>
                    <div className="composer-send-mode">
                      <button type="button" className={`composer-mode-btn ${sendMode === 'bcc' ? 'active' : ''}`} onClick={() => setSendMode('bcc')}>
                        <i className="fas fa-eye-slash"></i> BCC
                      </button>
                      <button type="button" className={`composer-mode-btn ${sendMode === 'direct' ? 'active' : ''}`} onClick={() => setSendMode('direct')}>
                        <i className="fas fa-paper-plane"></i> Direct
                      </button>
                    </div>
                  </div>

                  <div style={{ marginTop: 8 }}>
                    <label className="composer-field-label">Distribution</label>
                    <div className="composer-send-mode">
                      <button type="button" className={`composer-mode-btn ${senderDistribution === 'round_robin' ? 'active' : ''}`} onClick={() => setSenderDistribution('round_robin')}>
                        Round-robin
                      </button>
                      <button type="button" className={`composer-mode-btn ${senderDistribution === 'parallel' ? 'active' : ''}`} onClick={() => setSenderDistribution('parallel')}>
                        Parallel
                      </button>
                    </div>
                    {senderDistribution === 'parallel' && (
                      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
                        <label style={{ fontSize: 12, color: '#6b7280' }}>Max concurrent</label>
                        <input type="number" min={1} max={5} value={maxParallelSenders} onChange={e => setMaxParallelSenders(Number(e.target.value))} style={{ width: 64, padding: '5px 8px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13 }} />
                      </div>
                    )}
                  </div>
                </div>

                {/* Recipients column */}
                <div>
                  <label className="composer-field-label">Recipients</label>
                  <div className="composer-recipients-search">
                    <i className="fas fa-search"></i>
                    <input type="text" placeholder="Filter recipients..." value={searchFilter} onChange={e => setSearchFilter(e.target.value)} />
                  </div>

                  <div className="composer-hygiene-grid">
                    <label>
                      <input type="checkbox" checked={hygiene.onlySelectedSenderLeads} onChange={e => setHygiene(prev => ({ ...prev, onlySelectedSenderLeads: e.target.checked }))} />
                      Only sender leads
                    </label>
                    <label>
                      <input type="checkbox" checked={hygiene.excludeSameDomain} onChange={e => setHygiene(prev => ({ ...prev, excludeSameDomain: e.target.checked }))} />
                      Exclude same domain
                    </label>
                    <label>
                      <input type="checkbox" checked={hygiene.excludeNoReplyLike} onChange={e => setHygiene(prev => ({ ...prev, excludeNoReplyLike: e.target.checked }))} />
                      Suppress no-reply
                    </label>
                    <label>
                      <input type="checkbox" checked={hygiene.excludeRoleBased} onChange={e => setHygiene(prev => ({ ...prev, excludeRoleBased: e.target.checked }))} />
                      Suppress role-based
                    </label>
                    <label>
                      <input type="checkbox" checked={hygiene.excludeHoneypotLike} onChange={e => setHygiene(prev => ({ ...prev, excludeHoneypotLike: e.target.checked }))} />
                      Suppress honeypots
                    </label>
                  </div>

                  <div className="composer-recipients-list">
                    {filteredContacts.map(c => (
                      <div key={c.id} className={`composer-recipient-row ${selected.has(c.id) ? 'selected' : ''}`}>
                        <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleRecipient(c.id)} />
                        <div className="composer-recipient-info">
                          <div className="composer-recipient-name">{c.name}</div>
                          <div className="composer-recipient-email">{c.email}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="composer-recipients-footer">
                    <span>{selectedEligibleCount} / {eligibleContacts.length} eligible ({contacts.length} total)</span>
                    <button type="button" className="action-btn secondary" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setSelected(new Set(eligibleContacts.map(c => c.id)))}>
                      Select All
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Section 2: Compose */}
        <div className="composer-section">
          <div className="composer-section-header" onClick={() => toggleSection('compose')}>
            <span className="composer-section-title">
              <i className="fas fa-edit"></i> Compose Email
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                className="action-btn secondary"
                style={{ padding: '4px 10px', fontSize: 11 }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!expandedSections.compose) {
                    setExpandedSections(prev => ({ ...prev, compose: true }));
                    setShowTemplates(true);
                    return;
                  }
                  setShowTemplates(prev => !prev);
                }}
              >
                <i className="fas fa-file-alt"></i> Templates ({templates.length})
              </button>
              <i className={`fas fa-chevron-down composer-section-chevron ${expandedSections.compose ? 'open' : ''}`}></i>
            </div>
          </div>
          {expandedSections.compose && (
            <div className="composer-section-body">
              {showTemplates && templates.length > 0 && (
                <div className="composer-templates-dropdown">
                  {templates.map(t => (
                    <div key={t.id} className="composer-template-item" onClick={() => applyTemplate(t)}>
                      <i className="fas fa-file-alt" style={{ color: '#3b82f6' }}></i>
                      <div>
                        <div className="composer-template-name">{t.name}</div>
                        <div className="composer-template-subject">{t.subject}</div>
                      </div>
                      <span className="composer-template-type">{t.type}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="composer-field">
                <label className="composer-field-label">Subject</label>
                <input type="text" className="composer-field-input" placeholder="Email subject..." value={subject} onChange={e => setSubject(e.target.value)} />
              </div>

              <div className="composer-field">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <label className="composer-field-label" style={{ margin: 0 }}>Body</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div className="composer-body-toggle">
                      <button type="button" className={`composer-body-type ${bodyType === 'html' ? 'active' : ''}`} onClick={() => setBodyType('html')}>HTML</button>
                      <button type="button" className={`composer-body-type ${bodyType === 'plain' ? 'active' : ''}`} onClick={() => setBodyType('plain')}>Plain</button>
                    </div>
                  </div>
                </div>
              </div>

              <div className={`composer-editor-preview-grid ${showInlinePreview ? '' : 'no-preview'}`}>
                <textarea
                  className="composer-body-textarea"
                  placeholder="Write your email content here..."
                  value={emailBody}
                  onChange={e => setEmailBody(e.target.value)}
                  rows={14}
                />
                {showInlinePreview && (
                  <div className="composer-preview-frame">
                    <div className="composer-preview-header">
                      <span>Preview (scripts blocked)</span>
                      <button type="button" className="icon-btn small" onClick={() => setShowFullPreview(true)} title="Fullscreen preview">
                        <i className="fas fa-expand"></i>
                      </button>
                    </div>
                    <iframe title="Email preview" sandbox="" srcDoc={previewSrcDoc} className="composer-preview-iframe" />
                  </div>
                )}
              </div>

              <div className="composer-attachments">
                <div className="composer-attachments-header">
                  <span><i className="fas fa-paperclip"></i> Attachments ({attachments.length})</span>
                  <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={onPickFiles} />
                  <button type="button" className="action-btn secondary" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => fileInputRef.current?.click()}>
                    <i className="fas fa-plus"></i> Add files
                  </button>
                </div>
                {attachments.length === 0 ? (
                  <div className="composer-no-attachments">No attachments</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {attachments.map(a => (
                      <div key={a.id} className="composer-attachment-item">
                        <i className="fas fa-file" style={{ color: '#6b7280' }}></i>
                        <span style={{ flex: 1 }}>{a.name}</span>
                        <button type="button" className="icon-btn small" onClick={() => removeAttachment(a.id)} aria-label="Remove">
                          <i className="fas fa-times"></i>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Section 3: Send Settings */}
        <div className="composer-section">
          <div className="composer-section-header" onClick={() => toggleSection('settings')}>
            <span className="composer-section-title">
              <i className="fas fa-cog"></i> Send Settings
            </span>
            <i className={`fas fa-chevron-down composer-section-chevron ${expandedSections.settings ? 'open' : ''}`}></i>
          </div>
          {expandedSections.settings && (
            <div className="composer-section-body">
              <div className="composer-send-settings">
                <div className="composer-send-setting">
                  <label>Batch Size</label>
                  <input type="number" value={batchSize} onChange={e => setBatchSize(Number(e.target.value))} min={1} max={100} />
                </div>
                <div className="composer-send-setting">
                  <label>Delay (sec)</label>
                  <input type="number" value={batchDelay} onChange={e => setBatchDelay(Number(e.target.value))} min={0} max={300} />
                </div>
                <div className="composer-send-setting">
                  <label>Mode</label>
                  <span className="composer-mode-badge">
                    {sendMode === 'bcc' ? 'BCC' : 'Direct'} · {selectedSenderEmails.size} sender(s)
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Actions bar */}
        <div className="composer-actions">
          <button
            type="button"
            className="action-btn primary"
            style={{ padding: '12px 28px' }}
            disabled={sending || accounts.length === 0 || selectedSenderEmails.size === 0}
            onClick={() => void handleSend()}
          >
            <i className="fas fa-paper-plane"></i> {sending ? 'Sending…' : `Send to ${selectedEligibleCount} Recipients`}
          </button>
          <button type="button" className="action-btn secondary" style={{ padding: '12px 20px' }} onClick={() => setShowInlinePreview(p => !p)}>
            <i className="fas fa-eye"></i> {showInlinePreview ? 'Hide Preview' : 'Side Preview'}
          </button>
          <button type="button" className="action-btn secondary" style={{ padding: '12px 20px' }} onClick={() => setShowFullPreview(true)}>
            <i className="fas fa-expand"></i> Fullscreen Preview
          </button>
        </div>
      </div>

      {showFullPreview && (
        <HtmlPreviewModal
          srcDoc={previewSrcDoc}
          title="Email Preview"
          onClose={() => setShowFullPreview(false)}
        />
      )}
    </div>
  );
};

export default EmailComposerView;
