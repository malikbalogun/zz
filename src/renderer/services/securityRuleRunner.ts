import type { UIAccount } from '../../types/store';
import type { SecurityRule } from './securityFilterService';
import { getSecurityRules, updateSecurityRule } from './securityFilterService';
import { getAccounts } from './accountService';
import { getSettings } from './settingsService';
import { getOutlookService } from './outlookService';
import type { OutlookMessage } from './outlookService';

type OutlookMail = ReturnType<typeof getOutlookService>;

export function ruleMatches(rule: SecurityRule, msg: OutlookMessage): boolean {
  const subj = (msg.subject || '').toLowerCase();
  const prev = (msg.bodyPreview || '').toLowerCase();
  const blob = `${subj} ${prev}`;
  const from = (msg.from?.emailAddress?.address || '').toLowerCase();

  const val = rule.value.trim().toLowerCase();
  if (!val) return false;

  switch (rule.type) {
    case 'keyword':
      return blob.includes(val);
    case 'domain': {
      const dom = val.startsWith('@') ? val.slice(1) : val;
      if (!from) return false;
      return from.endsWith(`@${dom}`) || from === dom;
    }
    case 'sender':
      return from.includes(val) || from === val;
    default:
      return false;
  }
}

/** Account-specific rules first, then global (so you can override per mailbox). */
function applicableRules(rules: SecurityRule[], accountId: string): SecurityRule[] {
  const acc = rules.filter(r => r.scope === 'account' && r.accountId === accountId);
  const glob = rules.filter(r => r.scope === 'global');
  return [...acc, ...glob];
}

async function executeAction(
  account: UIAccount,
  messageId: string,
  action: SecurityRule['action'],
  Outlook: OutlookMail
): Promise<void> {
  switch (action) {
    case 'junk': {
      const junkId = await Outlook.getWellKnownFolderId(account, 'JunkEmail');
      await Outlook.moveMessage(account, messageId, junkId);
      break;
    }
    case 'delete':
      await Outlook.deleteMessage(account, messageId);
      break;
    case 'read':
      await Outlook.setMessageReadState(account, messageId, true);
      break;
    default:
      break;
  }
}

export interface RunSecurityRulesResult {
  accountsProcessed: number;
  messagesAffected: number;
  errors: string[];
}

/**
 * Scan recent Inbox messages on each token account and apply matching rules (move to Junk, delete, or mark read).
 */
export async function runSecurityRulesBatch(opts?: {
  accountIds?: string[];
  maxMessagesPerInbox?: number;
  /** Manual "Apply" from Security view runs even when the master toggle is off. */
  ignoreMasterSwitch?: boolean;
}): Promise<RunSecurityRulesResult> {
  const settings = await getSettings();
  if (!opts?.ignoreMasterSwitch && settings.security?.filterEnabled === false) {
    return { accountsProcessed: 0, messagesAffected: 0, errors: ['Security filter is disabled. Turn it on under Global settings or use Apply now.'] };
  }

  const allRules = await getSecurityRules();
  const activeRules = allRules.filter(r => r.active);
  if (activeRules.length === 0) {
    return { accountsProcessed: 0, messagesAffected: 0, errors: ['No active rules'] };
  }

  const accounts = (await getAccounts()).filter(
    a => a.auth?.type === 'token' && a.status === 'active'
  );
  const idSet = opts?.accountIds?.length ? new Set(opts.accountIds) : null;
  const targets = idSet ? accounts.filter(a => idSet.has(a.id)) : accounts;

  const Outlook = getOutlookService();
  const max = opts?.maxMessagesPerInbox ?? 120;
  let messagesAffected = 0;
  const errors: string[] = [];
  let accountsProcessed = 0;

  for (const account of targets) {
    const forAccount = applicableRules(activeRules, account.id);
    if (forAccount.length === 0) continue;

    accountsProcessed += 1;

    try {
      const folders = await Outlook.listFolders(account);
      const inbox = folders.find(f => f.displayName.toLowerCase() === 'inbox') || folders[0];
      if (!inbox) {
        errors.push(`${account.email}: no folders`);
        continue;
      }
      const messages = await Outlook.fetchMessages(account, inbox.id, undefined, max);
      const processedIds = new Set<string>();

      for (const msg of messages) {
        if (!msg.id || processedIds.has(msg.id)) continue;

        const match = forAccount.find(r => ruleMatches(r, msg));
        if (!match) continue;

        try {
          await executeAction(account, msg.id, match.action, Outlook);
          processedIds.add(msg.id);
          messagesAffected += 1;

          const now = new Date().toISOString();
          const nextCount = match.matchCount + 1;
          await updateSecurityRule(match.id, {
            matchCount: nextCount,
            lastTriggered: now,
          });
          match.matchCount = nextCount;
          match.lastTriggered = now;
        } catch (e: unknown) {
          const msgErr = e instanceof Error ? e.message : String(e);
          errors.push(`${account.email} (${msg.id.slice(0, 12)}…): ${msgErr}`);
        }

        await new Promise(r => setTimeout(r, 60));
      }
    } catch (e: unknown) {
      const msgErr = e instanceof Error ? e.message : String(e);
      errors.push(`${account.email}: ${msgErr}`);
    }
  }

  return {
    accountsProcessed,
    messagesAffected,
    errors,
  };
}
