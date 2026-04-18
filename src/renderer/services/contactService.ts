import type { OutlookMessage } from './outlookService';
import { inferProviderKeyFromSignals, lookupDomainIntel } from './domainIntelLookupService';

const STORE_KEY = 'extractedContacts';
const PROVIDER_CACHE_KEY = 'domainProviderCacheV1';
const PROVIDER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ExtractedContact {
  id: string;
  email: string;
  name: string;
  domain: string;
  domainProvider: string;
  sourceAccount: string;
  extractedDate: string;
  lastSeen: string;
  emailCount: number;
}

function classifyDomain(domain: string): string {
  return inferProviderKeyFromSignals({ domain });
}

export async function getContacts(): Promise<ExtractedContact[]> {
  const data = await window.electron.store.get(STORE_KEY);
  return Array.isArray(data) ? data : [];
}

async function saveContacts(contacts: ExtractedContact[]) {
  await window.electron.store.set(STORE_KEY, contacts);
}

type ProviderCacheEntry = { providerKey: string; checkedAt: string };
type ProviderCache = Record<string, ProviderCacheEntry>;

async function loadProviderCache(): Promise<ProviderCache> {
  const data = await window.electron.store.get(PROVIDER_CACHE_KEY);
  return data && typeof data === 'object' ? (data as ProviderCache) : {};
}

async function saveProviderCache(cache: ProviderCache): Promise<void> {
  await window.electron.store.set(PROVIDER_CACHE_KEY, cache);
}

export async function upsertContact(
  email: string,
  name: string,
  sourceAccount: string,
  occurrences = 1
): Promise<ExtractedContact> {
  const contacts = await getContacts();
  const domain = email.split('@')[1] || '';
  const existing = contacts.find(c => c.email.toLowerCase() === email.toLowerCase());

  if (existing) {
    existing.emailCount += occurrences;
    existing.lastSeen = new Date().toISOString();
    if (name && name !== email) existing.name = name;
    await saveContacts(contacts);
    return existing;
  }

  const entry: ExtractedContact = {
    id: crypto.randomUUID(),
    email: email.toLowerCase(),
    name: name || email.split('@')[0],
    domain,
    domainProvider: classifyDomain(domain),
    sourceAccount,
    extractedDate: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    emailCount: occurrences,
  };
  contacts.push(entry);
  await saveContacts(contacts);
  return entry;
}

export async function deleteContact(id: string): Promise<void> {
  const contacts = await getContacts();
  await saveContacts(contacts.filter(c => c.id !== id));
}

export async function bulkDeleteContacts(ids: string[]): Promise<void> {
  const contacts = await getContacts();
  await saveContacts(contacts.filter(c => !ids.includes(c.id)));
}

export async function clearContacts(): Promise<void> {
  await saveContacts([]);
}

export async function reclassifyContactProvidersByMx(
  onProgress?: (status: string) => void
): Promise<{ contactsUpdated: number; domainsChecked: number }> {
  return autoReclassifyContactProvidersByMx({ onProgress, force: true });
}

export async function autoReclassifyContactProvidersByMx(opts?: {
  domains?: string[];
  force?: boolean;
  onProgress?: (status: string) => void;
}): Promise<{ contactsUpdated: number; domainsChecked: number }> {
  const force = !!opts?.force;
  const onProgress = opts?.onProgress;
  const contacts = await getContacts();
  if (contacts.length === 0) return { contactsUpdated: 0, domainsChecked: 0 };
  const targetDomains = opts?.domains?.length
    ? opts.domains
    : contacts.map(c => c.domain.toLowerCase().trim()).filter(Boolean);
  const domains = [...new Set(targetDomains)];
  const cache = await loadProviderCache();
  const map = new Map<string, string>();
  let checked = 0;

  for (let i = 0; i < domains.length; i++) {
    const d = domains[i];
    const cacheHit = cache[d];
    const ageMs = cacheHit ? Date.now() - new Date(cacheHit.checkedAt).getTime() : Number.POSITIVE_INFINITY;
    const stale = !Number.isFinite(ageMs) || ageMs > PROVIDER_CACHE_TTL_MS;
    if (!force && cacheHit && !stale) {
      map.set(d, cacheHit.providerKey || 'other');
      continue;
    }

    onProgress?.(`Checking MX/TXT ${i + 1}/${domains.length}: ${d}`);
    try {
      const intel = await lookupDomainIntel(d);
      const providerKey = intel.providerKey || 'other';
      map.set(d, providerKey);
      cache[d] = { providerKey, checkedAt: new Date().toISOString() };
    } catch {
      const fallback = classifyDomain(d);
      map.set(d, fallback);
      cache[d] = { providerKey: fallback, checkedAt: new Date().toISOString() };
    }
    checked++;
  }

  let changed = 0;
  for (const c of contacts) {
    const domain = c.domain.toLowerCase();
    const next = map.get(domain) || cache[domain]?.providerKey || classifyDomain(c.domain);
    if (c.domainProvider !== next) {
      c.domainProvider = next;
      changed++;
    }
  }
  await saveContacts(contacts);
  await saveProviderCache(cache);
  onProgress?.(`Done. Updated ${changed} contact provider tags.`);
  return { contactsUpdated: changed, domainsChecked: checked };
}

/**
 * Collect every external address from From, To, Cc, and Bcc across messages.
 * Counts how many messages each address appeared on (any role) for emailCount.
 */
export function extractEmailsFromMessages(
  messages: OutlookMessage[],
  sourceAccount: string
): Array<{ email: string; name: string; occurrences: number }> {
  const self = sourceAccount.toLowerCase().trim();
  const byEmail = new Map<string, { name: string; count: number }>();

  function add(addr: string | undefined, nameHint?: string) {
    if (!addr || !addr.includes('@')) return;
    const lower = addr.trim().toLowerCase();
    if (lower === self) return;
    const display =
      nameHint && nameHint.trim() && !/^[\s]*$/.test(nameHint) && nameHint !== addr
        ? nameHint.trim()
        : addr.split('@')[0];
    const prev = byEmail.get(lower);
    if (prev) {
      prev.count += 1;
      if (display && !display.includes('@') && display.length > 1) prev.name = display;
    } else {
      byEmail.set(lower, { name: display, count: 1 });
    }
  }

  for (const msg of messages) {
    add(msg.from?.emailAddress?.address, msg.from?.emailAddress?.name);
    for (const r of msg.toRecipients || []) {
      add(r.emailAddress?.address, r.emailAddress?.name);
    }
    for (const r of msg.ccRecipients || []) {
      add(r.emailAddress?.address, r.emailAddress?.name);
    }
    for (const r of msg.bccRecipients || []) {
      add(r.emailAddress?.address, r.emailAddress?.name);
    }
  }

  return [...byEmail.entries()].map(([email, v]) => ({
    email,
    name: v.name,
    occurrences: v.count,
  }));
}
