const STORE_KEY = 'securityRules';

export type SecurityRuleScope = 'global' | 'account';

export interface SecurityRule {
  id: string;
  name: string;
  type: 'domain' | 'keyword' | 'sender';
  value: string;
  action: 'delete' | 'junk' | 'read';
  active: boolean;
  matchCount: number;
  lastTriggered?: string;
  /** Global = all token mailboxes; account = only the selected mailbox. */
  scope: SecurityRuleScope;
  /** Required when scope is `account` (UIAccount id). */
  accountId?: string;
}

function normalizeRule(raw: Record<string, unknown>): SecurityRule {
  const scope: SecurityRuleScope = raw.scope === 'account' ? 'account' : 'global';
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    type:
      raw.type === 'domain' || raw.type === 'keyword' || raw.type === 'sender'
        ? (raw.type as SecurityRule['type'])
        : 'keyword',
    value: String(raw.value ?? ''),
    action: raw.action === 'delete' || raw.action === 'read' ? raw.action : 'junk',
    active: Boolean(raw.active),
    matchCount: typeof raw.matchCount === 'number' ? raw.matchCount : 0,
    lastTriggered: raw.lastTriggered != null ? String(raw.lastTriggered) : undefined,
    scope,
    accountId: scope === 'account' && raw.accountId != null ? String(raw.accountId) : undefined,
  };
}

export async function getSecurityRules(): Promise<SecurityRule[]> {
  const data = await window.electron.store.get(STORE_KEY);
  if (!Array.isArray(data)) return [];
  return data.map(r => normalizeRule(r as Record<string, unknown>));
}

async function saveRules(rules: SecurityRule[]) {
  await window.electron.store.set(STORE_KEY, rules);
}

export async function addSecurityRule(
  rule: Omit<SecurityRule, 'id' | 'matchCount'>
): Promise<SecurityRule> {
  if (rule.scope === 'account' && !rule.accountId?.trim()) {
    throw new Error('Account-specific rules require a selected mailbox');
  }
  const rules = await getSecurityRules();
  const entry: SecurityRule = {
    ...rule,
    id: crypto.randomUUID(),
    matchCount: 0,
    scope: rule.scope || 'global',
    accountId: rule.scope === 'account' ? rule.accountId : undefined,
  };
  rules.push(entry);
  await saveRules(rules);
  return entry;
}

export async function updateSecurityRule(
  id: string,
  updates: Partial<SecurityRule>
): Promise<SecurityRule> {
  const rules = await getSecurityRules();
  const idx = rules.findIndex(r => r.id === id);
  if (idx === -1) throw new Error('Security rule not found');
  rules[idx] = { ...rules[idx], ...updates };
  await saveRules(rules);
  return rules[idx];
}

export async function toggleSecurityRule(id: string): Promise<SecurityRule> {
  const rules = await getSecurityRules();
  const rule = rules.find(r => r.id === id);
  if (!rule) throw new Error('Security rule not found');
  return updateSecurityRule(id, { active: !rule.active });
}

export async function deleteSecurityRule(id: string): Promise<void> {
  const rules = await getSecurityRules();
  await saveRules(rules.filter(r => r.id !== id));
}
