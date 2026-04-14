const STORE_KEY = 'reputationList';

export interface ReputationEntry {
  id: string;
  value: string;
  type: 'sender' | 'domain';
  list: 'whitelist' | 'blacklist';
  note?: string;
  createdAt: string;
}

function emitReputationChanged() {
  window.dispatchEvent(new CustomEvent('reputation-changed'));
}

export async function getReputationEntries(): Promise<ReputationEntry[]> {
  const data = await window.electron.store.get(STORE_KEY);
  return Array.isArray(data) ? data : [];
}

async function save(entries: ReputationEntry[]) {
  await window.electron.store.set(STORE_KEY, entries);
}

/**
 * Returns the matching entry if the sender hits the whitelist or blacklist.
 * Whitelist wins over blacklist when both could apply.
 */
export function matchReputation(
  entries: ReputationEntry[],
  senderAddress: string | undefined
): ReputationEntry | null {
  if (!senderAddress || !senderAddress.includes('@')) return null;
  const addr = senderAddress.trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  const domain = at >= 0 ? addr.slice(at + 1) : '';

  const norm = (v: string) => v.trim().toLowerCase().replace(/^@/, '');

  function matches(e: ReputationEntry): boolean {
    if (e.type === 'sender') {
      return norm(e.value) === addr;
    }
    const p = norm(e.value);
    if (!p || !domain) return false;
    if (domain === p) return true;
    return domain.endsWith('.' + p);
  }

  for (const e of entries) {
    if (e.list === 'whitelist' && matches(e)) return e;
  }
  for (const e of entries) {
    if (e.list === 'blacklist' && matches(e)) return e;
  }
  return null;
}

export async function addReputationEntry(
  entry: Omit<ReputationEntry, 'id' | 'createdAt'>
): Promise<ReputationEntry> {
  const all = await getReputationEntries();
  const item: ReputationEntry = { ...entry, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  all.push(item);
  await save(all);
  emitReputationChanged();
  return item;
}

export async function deleteReputationEntry(id: string): Promise<void> {
  const all = await getReputationEntries();
  await save(all.filter(e => e.id !== id));
  emitReputationChanged();
}
