import { useState, useEffect, useMemo } from 'react';
import { getContacts, type ExtractedContact } from '../../services/contactService';
import { getAccounts } from '../../services/accountService';
import type { UIAccount } from '../../../types/store';
import {
  lookupDomainIntel,
  parseDomainInput,
  type DomainIntelLookup,
  type DnsQueryResult,
} from '../../services/domainIntelLookupService';

const PROVIDER_LABELS: Record<string, string> = {
  office365: 'Microsoft 365',
  outlook: 'Outlook / Hotmail',
  google: 'Google / Gmail',
  godaddy: 'GoDaddy',
  adfs: 'ADFS / Federation',
  okta: 'Okta',
  barracuda: 'Barracuda',
  microsoft: 'Microsoft',
  other: 'Other / custom',
};

function formatDnsResult(r: DnsQueryResult): string {
  if (r.error) return r.error;
  if (r.status !== 0) return `DNS status ${r.status}`;
  if (r.answers.length === 0) return 'No records';
  return r.answers.map(a => a.data).join('\n');
}

const DomainIntelView: React.FC = () => {
  const [contacts, setContacts] = useState<ExtractedContact[]>([]);
  const [accounts, setAccounts] = useState<UIAccount[]>([]);
  const [accountFilter, setAccountFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);

  const [lookupInput, setLookupInput] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [lookupResult, setLookupResult] = useState<DomainIntelLookup | null>(null);

  useEffect(() => {
    Promise.all([getContacts(), getAccounts()]).then(([c, a]) => {
      setContacts(c);
      setAccounts(a);
      setLoading(false);
    });
  }, []);

  const runLookup = async () => {
    setLookupError('');
    setLookupResult(null);
    const parsed = parseDomainInput(lookupInput);
    if (!parsed.ok) {
      setLookupError(parsed.error);
      return;
    }
    setLookupLoading(true);
    try {
      const result = await lookupDomainIntel(parsed.domain);
      setLookupResult(result);
    } catch (e: unknown) {
      setLookupError(e instanceof Error ? e.message : String(e));
    } finally {
      setLookupLoading(false);
    }
  };

  const filteredContacts = useMemo(() => {
    if (accountFilter === 'all') return contacts;
    return contacts.filter(x => x.sourceAccount === accountFilter);
  }, [contacts, accountFilter]);

  const domainMap: Record<string, { provider: string; count: number; emails: string[] }> = {};
  for (const c of filteredContacts) {
    if (!domainMap[c.domain]) {
      domainMap[c.domain] = { provider: c.domainProvider, count: 0, emails: [] };
    }
    domainMap[c.domain].count += c.emailCount;
    domainMap[c.domain].emails.push(c.email);
  }
  const domains = Object.entries(domainMap)
    .map(([domain, data]) => ({ domain, ...data }))
    .sort((a, b) => b.count - a.count);

  const providerGroups: Record<string, number> = {};
  for (const d of domains) {
    providerGroups[d.provider] = (providerGroups[d.provider] || 0) + d.emails.length;
  }

  if (loading) return <div className="db-loading">Loading domain intelligence...</div>;

  return (
    <div className="feature-shell">
      <div
        className="feature-head"
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, justifyContent: 'space-between' }}
      >
        <h2>Domain Intelligence</h2>
      </div>

      <div className="feature-card" style={{ marginBottom: 16 }}>
        <div className="feature-card-title">
          <i className="fas fa-bolt" style={{ color: '#2563eb', marginRight: 8 }}></i>
          Live DNS lookup
        </div>
        <p className="feature-muted" style={{ marginBottom: 12, fontSize: 13 }}>
          Enter an <strong>email</strong> or <strong>domain</strong> — we query public DNS (MX, SPF/DMARC hints via TXT)
          over HTTPS. This does not use your mailbox; it works for any address.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
          <div className="form-group" style={{ margin: 0, flex: '1 1 280px' }}>
            <label className="form-label">Email or domain</label>
            <input
              className="form-input"
              placeholder="user@company.com or company.com"
              value={lookupInput}
              onChange={e => setLookupInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && void runLookup()}
            />
          </div>
          <button className="action-btn primary" type="button" disabled={lookupLoading} onClick={() => void runLookup()}>
            <i className={`fas ${lookupLoading ? 'fa-spinner fa-spin' : 'fa-search'}`}></i>{' '}
            {lookupLoading ? 'Querying…' : 'Look up'}
          </button>
        </div>
        {lookupError && (
          <div style={{ marginTop: 12, color: '#b91c1c', fontSize: 13 }}>{lookupError}</div>
        )}
        {lookupResult && (
          <div style={{ marginTop: 16 }}>
            <div style={{ marginBottom: 12 }}>
              <strong style={{ fontSize: 18 }}>{lookupResult.domain}</strong>
              <div className="feature-muted" style={{ marginTop: 4 }}>
                Inferred host / provider: <strong style={{ color: '#1e40af' }}>{lookupResult.providerGuess}</strong>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
              {[
                { label: 'A (IPv4)', r: lookupResult.records.a },
                { label: 'MX (mail servers)', r: lookupResult.records.mx },
                { label: 'NS (nameservers)', r: lookupResult.records.ns },
                { label: 'TXT @ domain (SPF & more)', r: lookupResult.records.txtRoot },
                { label: 'TXT _dmarc (DMARC)', r: lookupResult.records.txtDmarc },
              ].map(({ label, r }) => (
                <div
                  key={label}
                  style={{
                    border: '1px solid #e5e7eb',
                    borderRadius: 8,
                    padding: 12,
                    background: '#fafafa',
                    fontSize: 12,
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 8, color: '#374151' }}>{label}</div>
                  <pre
                    style={{
                      margin: 0,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      fontFamily: 'ui-monospace, monospace',
                      fontSize: 11,
                      color: '#1f2937',
                    }}
                  >
                    {formatDnsResult(r)}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="feature-head" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, fontSize: 18 }}>From extracted contacts</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label className="form-label" style={{ margin: 0 }}>
            Mailbox
          </label>
          <select
            className="form-input"
            style={{ minWidth: 260 }}
            value={accountFilter}
            onChange={e => setAccountFilter(e.target.value)}
          >
            <option value="all">All accounts ({contacts.length} contacts)</option>
            {accounts.map(a => (
              <option key={a.id} value={a.email}>
                {a.email} ({contacts.filter(c => c.sourceAccount === a.email).length})
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="feature-muted" style={{ marginBottom: 16 }}>
        These charts use addresses saved by <strong>Contacts → Extract</strong> from your mail — not a live message
        picker. Use <strong>Live DNS lookup</strong> above for any domain from an email you received.
      </p>
      <div className="feature-kpis" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="feature-kpi">
          <strong>{domains.length}</strong>
          <span>Unique domains</span>
        </div>
        <div className="feature-kpi">
          <strong>{Object.keys(providerGroups).length}</strong>
          <span>Provider tags</span>
        </div>
        <div className="feature-kpi">
          <strong>{filteredContacts.length}</strong>
          <span>Contacts (filtered)</span>
        </div>
      </div>

      <div className="feature-grid-2">
        <div className="feature-card">
          <div className="feature-card-title">Provider breakdown</div>
          {Object.keys(providerGroups).length === 0 && (
            <div className="feature-muted">
              No contacts for this filter. Go to <strong>Contacts</strong> and run extraction on a mailbox first.
            </div>
          )}
          {Object.entries(providerGroups)
            .sort((a, b) => b[1] - a[1])
            .map(([provider, count]) => (
              <div className="feature-row" key={provider}>
                <span>{PROVIDER_LABELS[provider] || provider}</span>
                <strong>{count} contacts</strong>
              </div>
            ))}
        </div>
        <div className="feature-card">
          <div className="feature-card-title">Top domains by volume</div>
          {domains.length === 0 && (
            <div className="feature-muted">No domain data until contacts are extracted.</div>
          )}
          {domains.slice(0, 20).map(d => (
            <div className="feature-row" key={d.domain}>
              <div style={{ flex: 1 }}>
                <strong>{d.domain}</strong>
                <div className="feature-muted">
                  {PROVIDER_LABELS[d.provider] || d.provider} · {d.emails.length} contacts
                </div>
              </div>
              <strong>{d.count}</strong>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default DomainIntelView;
