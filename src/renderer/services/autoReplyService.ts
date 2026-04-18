import type {
  AutoReplyRule,
  AutoReplyEvent,
  AutoReplyScope,
  AutoReplyActionType,
  AutoReplyTriggerType,
} from '../../types/store';

const RULES_KEY = 'autoReplyRules';
const EVENTS_KEY = 'autoReplyEvents';
const DEDUPE_KEY = 'autoReplyDedupe';

const MAX_DEDUPE = 8000;

// ── Rules CRUD ──────────────────────────────────────────────────────

function normalizeTrigger(t: unknown): AutoReplyTriggerType {
  const s = String(t || '');
  if (
    s === 'all' ||
    s === 'sender' ||
    s === 'keyword' ||
    s === 'thread' ||
    s === 'subject' ||
    s === 'conversation'
  ) {
    return s;
  }
  return 'sender';
}

function normalizeAction(a: unknown): AutoReplyActionType {
  const s = String(a || '');
  if (s === 'delete' || s === 'junk' || s === 'mark_read') return s;
  return 'reply';
}

function normalizeRule(raw: Record<string, unknown>): AutoReplyRule {
  const legacyAccount = raw.accountId != null ? String(raw.accountId) : '';
  const scope: AutoReplyScope = raw.scope === 'global' ? 'global' : 'account';
  const triggerType = normalizeTrigger(raw.triggerType);
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    enabled: Boolean(raw.enabled),
    scope,
    accountId: scope === 'account' ? legacyAccount : undefined,
    action: normalizeAction(raw.action),
    triggerType,
    triggerValue: String(raw.triggerValue ?? ''),
    referenceMessageId: raw.referenceMessageId != null ? String(raw.referenceMessageId) : undefined,
    referenceConversationId:
      raw.referenceConversationId != null ? String(raw.referenceConversationId) : undefined,
    referenceSubjectHint: raw.referenceSubjectHint != null ? String(raw.referenceSubjectHint) : undefined,
    ackAllInboxRisk: Boolean(raw.ackAllInboxRisk),
    delayMinutes: typeof raw.delayMinutes === 'number' ? raw.delayMinutes : 3,
    templateSubject: String(raw.templateSubject ?? ''),
    templateBody: String(raw.templateBody ?? ''),
    createdAt: String(raw.createdAt ?? new Date().toISOString()),
    updatedAt: String(raw.updatedAt ?? new Date().toISOString()),
    lastMatchedAt: raw.lastMatchedAt != null ? String(raw.lastMatchedAt) : undefined,
    lastSentAt: raw.lastSentAt != null ? String(raw.lastSentAt) : undefined,
    matchCount: typeof raw.matchCount === 'number' ? raw.matchCount : 0,
  };
}

export async function getAutoReplyRules(): Promise<AutoReplyRule[]> {
  const data = await window.electron.store.get(RULES_KEY);
  if (!Array.isArray(data)) return [];
  return data.map(r => normalizeRule(r as Record<string, unknown>));
}

async function saveRules(rules: AutoReplyRule[]) {
  await window.electron.store.set(RULES_KEY, rules);
}

export async function addAutoReplyRule(
  rule: Omit<AutoReplyRule, 'id' | 'createdAt' | 'updatedAt' | 'matchCount'>
): Promise<AutoReplyRule> {
  if (rule.scope === 'account' && !rule.accountId?.trim()) {
    throw new Error('Select a mailbox for account-scoped rules');
  }
  if (rule.triggerType === 'conversation' && !rule.referenceConversationId?.trim()) {
    throw new Error('Pick an anchor message from Inbox or Sent to use conversation matching');
  }
  if (rule.triggerType === 'all' && !rule.ackAllInboxRisk) {
    throw new Error('Confirm that you want this rule to apply to every Inbox message');
  }
  if (rule.action === 'reply' && !rule.templateBody.trim()) {
    throw new Error('Reply rules need a message body');
  }
  const rules = await getAutoReplyRules();
  const now = new Date().toISOString();
  const newRule: AutoReplyRule = {
    ...rule,
    scope: rule.scope || 'account',
    accountId: rule.scope === 'global' ? undefined : rule.accountId,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    matchCount: 0,
  };
  rules.push(newRule);
  await saveRules(rules);
  return newRule;
}

export async function updateAutoReplyRule(
  id: string,
  updates: Partial<AutoReplyRule>
): Promise<AutoReplyRule> {
  const rules = await getAutoReplyRules();
  const idx = rules.findIndex(r => r.id === id);
  if (idx === -1) throw new Error('Auto-reply rule not found');
  rules[idx] = { ...rules[idx], ...updates, updatedAt: new Date().toISOString() };
  await saveRules(rules);
  return rules[idx];
}

export async function deleteAutoReplyRule(id: string): Promise<void> {
  const rules = await getAutoReplyRules();
  await saveRules(rules.filter(r => r.id !== id));
}

export async function toggleAutoReplyRule(id: string): Promise<AutoReplyRule> {
  const rules = await getAutoReplyRules();
  const rule = rules.find(r => r.id === id);
  if (!rule) throw new Error('Auto-reply rule not found');
  return updateAutoReplyRule(id, { enabled: !rule.enabled });
}

// ── Dedupe (rule + message id already handled) ─────────────────────

async function getDedupeKeys(): Promise<string[]> {
  const data = await window.electron.store.get(DEDUPE_KEY);
  return Array.isArray(data) ? data.map(String) : [];
}

async function saveDedupeKeys(keys: string[]) {
  const trimmed = keys.slice(-MAX_DEDUPE);
  await window.electron.store.set(DEDUPE_KEY, trimmed);
}

export function dedupeKey(ruleId: string, messageId: string): string {
  return `${ruleId}::${messageId}`;
}

export async function hasAutoReplyProcessed(ruleId: string, messageId: string): Promise<boolean> {
  const k = dedupeKey(ruleId, messageId);
  const keys = await getDedupeKeys();
  return keys.includes(k);
}

export async function markAutoReplyProcessed(ruleId: string, messageId: string): Promise<void> {
  const k = dedupeKey(ruleId, messageId);
  const keys = await getDedupeKeys();
  if (keys.includes(k)) return;
  keys.push(k);
  await saveDedupeKeys(keys);
}

// ── Events log ──────────────────────────────────────────────────────

export async function getAutoReplyEvents(): Promise<AutoReplyEvent[]> {
  const data = await window.electron.store.get(EVENTS_KEY);
  return Array.isArray(data) ? data : [];
}

export async function addAutoReplyEvent(
  event: Omit<AutoReplyEvent, 'id' | 'timestamp'>
): Promise<AutoReplyEvent> {
  const events = await getAutoReplyEvents();
  const entry: AutoReplyEvent = {
    ...event,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };
  events.push(entry);
  if (events.length > 500) events.splice(0, events.length - 500);
  await window.electron.store.set(EVENTS_KEY, events);
  return entry;
}

export async function clearAutoReplyEvents(): Promise<void> {
  await window.electron.store.set(EVENTS_KEY, []);
}
