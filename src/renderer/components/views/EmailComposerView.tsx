import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { UIAccount } from '../../../types/store';
import { getAccounts } from '../../services/accountService';
import { getContacts, type ExtractedContact } from '../../services/contactService';
import { getTemplates, type EmailTemplate } from '../../services/templateService';
import { getOutlookService } from '../../services/outlookService';

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
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,-apple-system,sans-serif;padding:16px;margin:0;white-space:pre-wrap;word-break:break-word;}</style></head><body>${esc}</body></html>`;
  }
  const t = body.trim();
  if (/^<!DOCTYPE/i.test(t) || /^<html[\s>]/i.test(t)) return body;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Segoe UI,Roboto,sans-serif;padding:16px;margin:0;font-size:14px;}</style></head><body>${body}</body></html>`;
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
  /** Which token mailboxes may send (multi-select for B2B / rotation). */
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
  const [showPreview, setShowPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendMessage, setSendMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    accounts,
    selectedSenderEmails,
    senderDistribution,
    maxParallelSenders,
    subject,
    emailBody,
    bodyType,
    eligibleContacts,
    selected,
    sendMode,
    batchSize,
    batchDelay,
    attachments,
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
            marginBottom: 12,
            padding: '10px 14px',
            borderRadius: 8,
            fontSize: 13,
            background: sendMessage.type === 'ok' ? '#ecfdf5' : '#fef2f2',
            border: `1px solid ${sendMessage.type === 'ok' ? '#a7f3d0' : '#fecaca'}`,
            color: sendMessage.type === 'ok' ? '#065f46' : '#991b1b',
          }}
        >
          {sendMessage.text}
        </div>
      )}

      <div className="composer-stats-bar">
        <div className="inbox-stat">
          <i className="fas fa-users" style={{ color: '#3b82f6' }}></i>
          <span className="inbox-stat-val">{eligibleContacts.length}</span>
          <span className="inbox-stat-label">Eligible Recipients</span>
        </div>
        <div className="inbox-stat">
          <i className="fas fa-check-circle" style={{ color: '#10b981' }}></i>
          <span className="inbox-stat-val">{selectedEligibleCount}</span>
          <span className="inbox-stat-label">Selected</span>
        </div>
        <div className="inbox-stat">
          <i className="fas fa-layer-group" style={{ color: '#8b5cf6' }}></i>
          <span className="inbox-stat-val">{batchSize}</span>
          <span className="inbox-stat-label">Batch Size</span>
        </div>
        <div className="inbox-stat">
          <i className="fas fa-file-alt" style={{ color: '#f59e0b' }}></i>
          <span className="inbox-stat-val">{templates.length}</span>
          <span className="inbox-stat-label">Templates</span>
        </div>
        <div className="inbox-stat">
          <i className="fas fa-at" style={{ color: '#ec4899' }}></i>
          <span className="inbox-stat-val">{selectedSenderEmails.size}</span>
          <span className="inbox-stat-label">Senders</span>
        </div>
      </div>

      <div className="composer-layout">
        <div className="composer-recipients-panel">
          <div className="composer-panel-header">
            <span className="composer-panel-title">
              <i className="fas fa-users"></i> Recipients
            </span>
          </div>
          <div className="composer-send-mode">
            <button
              type="button"
              className={`composer-mode-btn ${sendMode === 'bcc' ? 'active' : ''}`}
              onClick={() => setSendMode('bcc')}
            >
              <i className="fas fa-eye-slash"></i> BCC
            </button>
            <button
              type="button"
              className={`composer-mode-btn ${sendMode === 'direct' ? 'active' : ''}`}
              onClick={() => setSendMode('direct')}
            >
              <i className="fas fa-paper-plane"></i> Direct
            </button>
          </div>
          <p style={{ fontSize: 11, color: '#6b7280', padding: '0 12px 8px', lineHeight: 1.4 }}>
            BCC: one send per batch (you appear in To). Direct: separate message per recipient. Large mailings affect deliverability; use sensible batching.
          </p>
          <div className="composer-recipients-search">
            <i className="fas fa-search"></i>
            <input
              type="text"
              placeholder="Filter recipients..."
              value={searchFilter}
              onChange={e => setSearchFilter(e.target.value)}
            />
          </div>
          <div style={{ padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#374151' }}>
              <input
                type="checkbox"
                checked={hygiene.onlySelectedSenderLeads}
                onChange={e => setHygiene(prev => ({ ...prev, onlySelectedSenderLeads: e.target.checked }))}
              />
              Only leads extracted from selected sender mailbox(es)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#374151' }}>
              <input
                type="checkbox"
                checked={hygiene.excludeSameDomain}
                onChange={e => setHygiene(prev => ({ ...prev, excludeSameDomain: e.target.checked }))}
              />
              Exclude same-domain recipients as sender(s)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#374151' }}>
              <input
                type="checkbox"
                checked={hygiene.excludeNoReplyLike}
                onChange={e => setHygiene(prev => ({ ...prev, excludeNoReplyLike: e.target.checked }))}
              />
              Suppress no-reply / auto-notification addresses
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#374151' }}>
              <input
                type="checkbox"
                checked={hygiene.excludeRoleBased}
                onChange={e => setHygiene(prev => ({ ...prev, excludeRoleBased: e.target.checked }))}
              />
              Suppress role-based inboxes (admin, support, info, sales, etc.)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#374151' }}>
              <input
                type="checkbox"
                checked={hygiene.excludeHoneypotLike}
                onChange={e => setHygiene(prev => ({ ...prev, excludeHoneypotLike: e.target.checked }))}
              />
              Suppress honeypot/spamtrap-like addresses
            </label>
            <div style={{ fontSize: 11, color: '#6b7280' }}>
              Showing {filteredContacts.length} / eligible {eligibleContacts.length} / total extracted {contacts.length}
            </div>
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
            <span>
              {selectedEligibleCount} of {eligibleContacts.length} eligible selected
            </span>
            <button
              type="button"
              className="action-btn secondary"
              style={{ padding: '4px 10px', fontSize: 11 }}
              onClick={() => setSelected(new Set(eligibleContacts.map(c => c.id)))}
            >
              Select Eligible
            </button>
          </div>
        </div>

        <div className="composer-editor-panel">
          <div className="composer-panel-header">
            <span className="composer-panel-title">
              <i className="fas fa-edit"></i> Compose Email
            </span>
            <button
              type="button"
              className={`action-btn secondary ${showTemplates ? 'active' : ''}`}
              style={{ padding: '5px 10px', fontSize: 11 }}
              onClick={() => setShowTemplates(!showTemplates)}
            >
              <i className="fas fa-file-alt"></i> Templates ({templates.length})
            </button>
          </div>

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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label className="composer-field-label" style={{ margin: 0 }}>
                From (multi-mailbox)
              </label>
              <button
                type="button"
                className="action-btn secondary"
                style={{ fontSize: 11, padding: '4px 10px' }}
                onClick={() => setSelectedSenderEmails(new Set(accounts.map(a => a.email)))}
              >
                All senders
              </button>
            </div>
            <div
              style={{
                border: '1px solid #e5e7eb',
                borderRadius: 8,
                maxHeight: 140,
                overflowY: 'auto',
                padding: 8,
                fontSize: 13,
              }}
            >
              {accounts.length === 0 && (
                <div style={{ color: '#9ca3af' }}>No token accounts — add one in Accounts</div>
              )}
              {accounts.map(a => (
                <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer' }}>
                  <input type="checkbox" checked={selectedSenderEmails.has(a.email)} onChange={() => toggleSenderEmail(a.email)} />
                  <span>{a.email}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="composer-field">
            <label className="composer-field-label">Sender distribution</label>
            <div className="composer-send-mode" style={{ marginTop: 6 }}>
              <button
                type="button"
                className={`composer-mode-btn ${senderDistribution === 'round_robin' ? 'active' : ''}`}
                onClick={() => setSenderDistribution('round_robin')}
              >
                Round-robin
              </button>
              <button
                type="button"
                className={`composer-mode-btn ${senderDistribution === 'parallel' ? 'active' : ''}`}
                onClick={() => setSenderDistribution('parallel')}
              >
                Parallel
              </button>
            </div>
            {senderDistribution === 'parallel' && (
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={{ fontSize: 12, color: '#6b7280' }}>Max concurrent</label>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={maxParallelSenders}
                  onChange={e => setMaxParallelSenders(Number(e.target.value))}
                  style={{ width: 64 }}
                />
              </div>
            )}
            <p style={{ fontSize: 11, color: '#6b7280', marginTop: 8, lineHeight: 1.4 }}>
              Multiple senders rotate across batches (BCC) or recipients (Direct). Parallel runs up to N sends at once, then waits your delay — use low N to reduce throttling.
            </p>
          </div>

          <div className="composer-field">
            <label className="composer-field-label">Subject</label>
            <input
              type="text"
              className="composer-field-input"
              placeholder="Email subject..."
              value={subject}
              onChange={e => setSubject(e.target.value)}
            />
          </div>

          <div className="composer-field">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label className="composer-field-label" style={{ margin: 0 }}>
                Body
              </label>
              <div className="composer-body-toggle">
                <button type="button" className={`composer-body-type ${bodyType === 'html' ? 'active' : ''}`} onClick={() => setBodyType('html')}>
                  HTML
                </button>
                <button type="button" className={`composer-body-type ${bodyType === 'plain' ? 'active' : ''}`} onClick={() => setBodyType('plain')}>
                  Plain
                </button>
              </div>
            </div>
          </div>

          <div style={{ display: showPreview ? 'grid' : 'block', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' }}>
            <textarea
              className="composer-body-textarea"
              placeholder="Write your email content here..."
              value={emailBody}
              onChange={e => setEmailBody(e.target.value)}
              rows={showPreview ? 14 : 12}
              style={showPreview ? { minHeight: 280 } : undefined}
            />
            {showPreview && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 280 }}>
                <label className="form-label" style={{ fontSize: 12 }}>
                  Preview (scripts blocked)
                </label>
                <iframe
                  title="Email preview"
                  sandbox=""
                  srcDoc={previewSrcDoc}
                  style={{
                    flex: 1,
                    minHeight: 240,
                    border: '1px solid #e5e7eb',
                    borderRadius: 8,
                    background: '#fff',
                  }}
                />
              </div>
            )}
          </div>

          <div className="composer-attachments">
            <div className="composer-attachments-header">
              <span>Attachments</span>
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onPickFiles} style={{ display: 'none' }} />
              <button type="button" className="action-btn secondary" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => fileInputRef.current?.click()}>
                <i className="fas fa-paperclip"></i> Add files
              </button>
            </div>
            {attachments.length === 0 ? (
              <div className="composer-no-attachments">No attachments</div>
            ) : (
              <ul style={{ listStyle: 'none', fontSize: 13 }}>
                {attachments.map(a => (
                  <li key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                    <i className="fas fa-file" style={{ color: '#6b7280' }}></i>
                    <span style={{ flex: 1 }}>{a.name}</span>
                    <button type="button" className="icon-btn small" onClick={() => removeAttachment(a.id)} aria-label="Remove attachment">
                      <i className="fas fa-times"></i>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

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
            <button type="button" className="action-btn secondary" style={{ padding: '12px 20px' }} onClick={() => setShowPreview(p => !p)}>
              <i className="fas fa-eye"></i> {showPreview ? 'Hide preview' : 'Preview'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default EmailComposerView;
