import type { UIAccount } from '../../types/store';
import type { AutoReplyRule } from '../../types/store';
import { getSettings } from './settingsService';
import { getAccounts } from './accountService';
import { getOutlookService } from './outlookService';
import type { OutlookMessage } from './outlookService';
import {
  getAutoReplyRules,
  updateAutoReplyRule,
  hasAutoReplyProcessed,
  markAutoReplyProcessed,
  addAutoReplyEvent,
} from './autoReplyService';

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function applyReplyTemplate(template: string, msg: OutlookMessage): string {
  const sub = msg.subject || '';
  return template
    .replace(/\{\{\s*original_subject\s*\}\}/gi, sub)
    .replace(/\{\{\s*subject\s*\}\}/gi, sub);
}

function delayElapsed(msg: OutlookMessage, delayMinutes: number): boolean {
  const received = new Date(msg.receivedDateTime).getTime();
  if (Number.isNaN(received)) return true;
  return Date.now() >= received + delayMinutes * 60 * 1000;
}

function applicableRules(rules: AutoReplyRule[], accountId: string): AutoReplyRule[] {
  const acc = rules.filter(
    r => r.enabled && r.scope === 'account' && r.accountId && r.accountId === accountId
  );
  const glob = rules.filter(r => r.enabled && r.scope === 'global');
  return [...acc, ...glob];
}

export function messageMatchesRule(rule: AutoReplyRule, msg: OutlookMessage): boolean {
  const fromAddr = (msg.from?.emailAddress?.address || '').toLowerCase();
  const subj = (msg.subject || '').toLowerCase();
  const prev = (msg.bodyPreview || '').toLowerCase();
  const blob = `${subj} ${prev}`;
  const val = rule.triggerValue.trim().toLowerCase();

  switch (rule.triggerType) {
    case 'all':
      return rule.ackAllInboxRisk === true;
    case 'sender':
      if (!val) return false;
      return fromAddr.includes(val) || fromAddr.endsWith(`@${val}`);
    case 'keyword':
      if (!val) return false;
      return blob.includes(val);
    case 'thread':
      if (!val) return false;
      return subj.includes(val);
    case 'subject':
      if (!val) return false;
      return subj.includes(val);
    case 'conversation': {
      const ref = rule.referenceConversationId?.trim();
      const cid = msg.conversationId?.trim();
      if (!ref || !cid) return false;
      return ref === cid;
    }
    default:
      return false;
  }
}

async function executeRule(
  account: UIAccount,
  rule: AutoReplyRule,
  msg: OutlookMessage,
  Outlook: ReturnType<typeof getOutlookService>
): Promise<void> {
  const action = rule.action;
  if (!msg.id) throw new Error('Missing message id');

  if (action === 'reply') {
    const raw = applyReplyTemplate(rule.templateBody, msg);
    const plain = stripHtml(raw) || '(auto-reply)';
    await Outlook.replyToMessage(account, msg.id, plain);
    return;
  }
  if (action === 'junk') {
    const junkId = await Outlook.getWellKnownFolderId(account, 'JunkEmail');
    await Outlook.moveMessage(account, msg.id, junkId);
    return;
  }
  if (action === 'delete') {
    await Outlook.deleteMessage(account, msg.id);
    return;
  }
  if (action === 'mark_read') {
    await Outlook.setMessageReadState(account, msg.id, true);
    return;
  }
}

export interface AutoReplyBatchResult {
  accountsProcessed: number;
  actionsTaken: number;
  errors: string[];
}

/**
 * Scan Inbox on each account; for each message, run the first matching enabled rule (reply / junk / delete / read).
 */
export async function runAutoReplyBatch(opts?: {
  /** Run even when Settings → Auto-reply engine is off (manual “Run now”). */
  ignoreEngineOff?: boolean;
  maxMessagesPerInbox?: number;
}): Promise<AutoReplyBatchResult> {
  const settings = await getSettings();
  if (!opts?.ignoreEngineOff && settings.autoReply?.engineEnabled !== true) {
    return { accountsProcessed: 0, actionsTaken: 0, errors: ['Auto-reply engine is off in Settings / Auto Reply.'] };
  }

  const allRules = await getAutoReplyRules();
  const enabled = allRules.filter(r => r.enabled);
  if (enabled.length === 0) {
    return { accountsProcessed: 0, actionsTaken: 0, errors: ['No enabled auto-reply rules'] };
  }

  const accounts = (await getAccounts()).filter(
    a => a.auth?.type === 'token' && a.status === 'active'
  );
  const Outlook = getOutlookService();
  const max = opts?.maxMessagesPerInbox ?? 100;
  let accountsProcessed = 0;
  let actionsTaken = 0;
  const errors: string[] = [];

  for (const account of accounts) {
    const rulesForAccount = applicableRules(enabled, account.id);
    if (rulesForAccount.length === 0) continue;
    accountsProcessed += 1;

    try {
      const folders = await Outlook.listFolders(account);
      const inbox = folders.find(f => f.displayName.toLowerCase() === 'inbox') || folders[0];
      if (!inbox) {
        errors.push(`${account.email}: no folders`);
        continue;
      }
      const messages = await Outlook.fetchMessages(account, inbox.id, undefined, max);

      for (const msg of messages) {
        if (!msg.id) continue;
        const fromAddr = (msg.from?.emailAddress?.address || '').toLowerCase();
        if (fromAddr === account.email.toLowerCase()) continue;

        for (const rule of rulesForAccount) {
          if (await hasAutoReplyProcessed(rule.id, msg.id)) continue;
          if (!delayElapsed(msg, rule.delayMinutes)) continue;
          if (!messageMatchesRule(rule, msg)) continue;

          try {
            await executeRule(account, rule, msg, Outlook);
            await markAutoReplyProcessed(rule.id, msg.id);

            const now = new Date().toISOString();
            const nextCount = (rule.matchCount || 0) + 1;
            await updateAutoReplyRule(rule.id, {
              matchCount: nextCount,
              lastMatchedAt: now,
              ...(rule.action === 'reply' ? { lastSentAt: now } : {}),
            });
            rule.matchCount = nextCount;

            await addAutoReplyEvent({
              ruleId: rule.id,
              accountId: account.id,
              messageId: msg.id,
              action: 'sent',
              detail: `${rule.action} ok`,
            });

            actionsTaken += 1;
          } catch (e: unknown) {
            const err = e instanceof Error ? e.message : String(e);
            errors.push(`${account.email}: ${err}`);
            await addAutoReplyEvent({
              ruleId: rule.id,
              accountId: account.id,
              messageId: msg.id,
              action: 'failed',
              detail: err,
            });
          }

          await new Promise(r => setTimeout(r, 80));
          break;
        }
      }
    } catch (e: unknown) {
      errors.push(`${account.email}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { accountsProcessed, actionsTaken, errors };
}
