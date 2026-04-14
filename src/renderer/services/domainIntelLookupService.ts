/**
 * Public DNS-over-HTTPS (Cloudflare) — no API key. Used for Domain Intel "live" lookup.
 * @see https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/
 */

export type DnsRecordType = 'A' | 'AAAA' | 'MX' | 'NS' | 'TXT';

export interface DnsJsonAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

export interface DnsQueryResult {
  type: DnsRecordType;
  status: number;
  answers: DnsJsonAnswer[];
  error?: string;
}

const CF_DOH = 'https://cloudflare-dns.com/dns-query';

function extractDomainFromInput(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.includes('@')) {
    const parts = s.split('@');
    const d = parts[parts.length - 1]?.trim();
    return d && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d) ? d : null;
  }
  const d = s.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
  return d && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d) ? d : null;
}

export function parseDomainInput(input: string): { ok: true; domain: string } | { ok: false; error: string } {
  const domain = extractDomainFromInput(input);
  if (!domain) {
    return { ok: false, error: 'Enter a domain (example.com) or email (user@example.com).' };
  }
  return { ok: true, domain };
}

async function queryDns(name: string, type: DnsRecordType): Promise<DnsQueryResult> {
  const url = `${CF_DOH}?name=${encodeURIComponent(name)}&type=${type}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
    });
    if (!res.ok) {
      return { type, status: res.status, answers: [], error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      Status: number;
      Answer?: DnsJsonAnswer[];
    };
    const answers = Array.isArray(data.Answer) ? data.Answer : [];
    return { type, status: data.Status, answers };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { type, status: -1, answers: [], error: msg };
  }
}

export interface DomainIntelLookup {
  domain: string;
  providerKey: string;
  providerGuess: string;
  records: {
    a: DnsQueryResult;
    mx: DnsQueryResult;
    ns: DnsQueryResult;
    txtRoot: DnsQueryResult;
    txtDmarc: DnsQueryResult;
  };
}

type ProviderRule = { key: string; label: string; patterns: RegExp[] };

const PROVIDER_RULES: ProviderRule[] = [
  {
    key: 'office365',
    label: 'Microsoft 365',
    patterns: [
      /protection\.outlook\.com/i,
      /\.mail\.protection\.outlook\.com/i,
      /\.onmicrosoft\.com/i,
      /office365\.com/i,
      /(^|\.)office\.com$/i,
    ],
  },
  {
    key: 'outlook',
    label: 'Outlook / Hotmail',
    patterns: [/^(?:outlook|hotmail|live|msn)\.com$/i, /outlook\.com/i, /hotmail\.com/i, /live\.com/i],
  },
  {
    key: 'google',
    label: 'Google / Gmail',
    patterns: [/aspmx\.l\.google\.com/i, /\.googlemail\.com/i, /(^|\.)gmail\.com$/i, /google\.com/i],
  },
  {
    key: 'godaddy',
    label: 'GoDaddy',
    patterns: [/secureserver\.net/i, /domaincontrol\.com/i, /godaddy\.com/i],
  },
  {
    key: 'adfs',
    label: 'ADFS / Federation',
    patterns: [/adfs/i, /sts\./i, /federat/i],
  },
  {
    key: 'okta',
    label: 'Okta',
    patterns: [/okta\.com/i, /oktapreview\.com/i],
  },
  {
    key: 'barracuda',
    label: 'Barracuda',
    patterns: [/barracuda/i],
  },
  {
    key: 'microsoft',
    label: 'Microsoft',
    patterns: [/microsoft\.com/i],
  },
];

function toProviderLabel(key: string): string {
  return PROVIDER_RULES.find(r => r.key === key)?.label || 'Other / custom mail host';
}

export function inferProviderKeyFromSignals(input: {
  domain: string;
  mxBlob?: string;
  txtBlob?: string;
  nsBlob?: string;
}): string {
  const blob = `${input.domain} ${input.mxBlob || ''} ${input.txtBlob || ''} ${input.nsBlob || ''}`.toLowerCase();
  for (const rule of PROVIDER_RULES) {
    if (rule.patterns.some(p => p.test(blob))) return rule.key;
  }
  return 'other';
}

export async function lookupDomainIntel(domain: string): Promise<DomainIntelLookup> {
  const d = domain.trim().toLowerCase();
  const [a, mx, ns, txtRoot, txtDmarc] = await Promise.all([
    queryDns(d, 'A'),
    queryDns(d, 'MX'),
    queryDns(d, 'NS'),
    queryDns(d, 'TXT'),
    queryDns(`_dmarc.${d}`, 'TXT'),
  ]);

  const mxBlob = mx.answers.map(x => x.data).join(' ');
  const txtBlob = txtRoot.answers.map(x => x.data).join(' ');
  const nsBlob = ns.answers.map(x => x.data).join(' ');
  const providerKey = inferProviderKeyFromSignals({
    domain: d,
    mxBlob,
    txtBlob,
    nsBlob,
  });
  const providerGuess = toProviderLabel(providerKey);

  return {
    domain: d,
    providerKey,
    providerGuess,
    records: {
      a,
      mx,
      ns,
      txtRoot,
      txtDmarc,
    },
  };
}

export { extractDomainFromInput };
