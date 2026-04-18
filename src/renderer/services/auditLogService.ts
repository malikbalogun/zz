const STORE_KEY = 'auditLog';

export interface AuditEntry {
  id: string;
  category: 'send' | 'rule' | 'ai' | 'task' | 'security' | 'extract' | 'token' | 'system';
  action: string;
  detail: string;
  timestamp: string;
  accountId?: string;
}

export async function getAuditLog(): Promise<AuditEntry[]> {
  const data = await window.electron.store.get(STORE_KEY);
  return Array.isArray(data) ? data : [];
}

export async function addAuditEntry(
  entry: Omit<AuditEntry, 'id' | 'timestamp'>
): Promise<AuditEntry> {
  const log = await getAuditLog();
  const item: AuditEntry = { ...entry, id: crypto.randomUUID(), timestamp: new Date().toISOString() };
  log.push(item);
  if (log.length > 1000) log.splice(0, log.length - 1000);
  await window.electron.store.set(STORE_KEY, log);
  return item;
}

export async function clearAuditLog(): Promise<void> {
  await window.electron.store.set(STORE_KEY, []);
}
