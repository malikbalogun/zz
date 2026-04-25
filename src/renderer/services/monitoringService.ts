import type { MonitoringRule, MonitoringAlert, UIAccount } from '../../types/store';
import { getAccounts } from './accountService';
import * as Outlook from './outlookService';

const RULES_STORE_KEY = 'monitoringRules';
const ALERTS_STORE_KEY = 'monitoringAlerts';

const SNIPPET_MAX = 160;

function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Centered excerpt around the first case-insensitive match of keyword in haystack. */
function buildKeywordSnippet(haystack: string, keyword: string, maxLen: number = SNIPPET_MAX): string {
  const normalized = haystack.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const kw = keyword.trim();
  if (!kw) {
    return normalized.length <= maxLen ? normalized : normalized.slice(0, maxLen - 1) + '…';
  }
  const lower = normalized.toLowerCase();
  const idx = lower.indexOf(kw.toLowerCase());
  if (idx < 0) {
    return normalized.length <= maxLen ? normalized : normalized.slice(0, maxLen - 1) + '…';
  }
  const half = Math.floor((maxLen - kw.length) / 2);
  let start = Math.max(0, idx - half);
  let end = Math.min(normalized.length, idx + kw.length + (maxLen - kw.length - (idx - start)));
  if (end - start > maxLen) end = start + maxLen;
  if (start > 0) start = Math.max(0, end - maxLen);
  let out = normalized.slice(start, end);
  if (start > 0) out = '…' + out;
  if (end < normalized.length) out = out + '…';
  return out;
}

function formatLocalTime(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

function computeMonitoringSince(rule: MonitoringRule): string {
  // Future-only: messages received at/after last poll or when the rule started.
  return rule.lastRun || rule.listenStartedAt || new Date().toISOString();
}

function senderMatchesRule(msg: { from?: { emailAddress?: { address?: string } } }, rule: MonitoringRule): boolean {
  if (rule.senderScope !== 'specific' || !rule.senderAddresses?.length) return true;
  const from = (msg.from?.emailAddress?.address || '').toLowerCase().trim();
  if (!from) return false;
  return rule.senderAddresses.some(a => {
    const t = a.trim().toLowerCase();
    return t.length > 0 && from.includes(t);
  });
}

// === Monitoring Rules ===
export async function getMonitoringRules(): Promise<MonitoringRule[]> {
  const rules = await window.electron.store.get(RULES_STORE_KEY);
  return Array.isArray(rules) ? rules : [];
}

export async function saveMonitoringRules(rules: MonitoringRule[]) {
  await window.electron.store.set(RULES_STORE_KEY, rules);
}

export async function addMonitoringRule(rule: Omit<MonitoringRule, 'id'>) {
  const rules = await getMonitoringRules();
  // Determine scenario type
  let scenarioType: 'keyword' | 'folder' | 'keyword-in-folder' | 'token' = 'keyword';
  if (rule.keywords.length > 0 && rule.folders.length > 0) {
    scenarioType = 'keyword-in-folder';
  } else if (rule.keywords.length === 0 && rule.folders.length > 0) {
    scenarioType = 'folder';
  } else if (rule.keywords.length > 0 && rule.folders.length === 0) {
    scenarioType = 'keyword';
  }
  const newRule: MonitoringRule = {
    ...rule,
    scenarioType,
    id: crypto.randomUUID(),
    listenStartedAt: rule.listenStartedAt ?? new Date().toISOString(),
    timeScope: 'live',
    senderScope: rule.senderScope ?? 'all',
    senderAddresses: rule.senderAddresses?.length ? rule.senderAddresses : [],
  };
  rules.push(newRule);
  await saveMonitoringRules(rules);
  return newRule;
}

/** Bumped when user pauses or deletes a rule so in-flight `pollRule` exits ASAP. */
const ruleAbortEpoch = new Map<string, number>();

function bumpMonitoringRuleAbort(ruleId: string): void {
  ruleAbortEpoch.set(ruleId, (ruleAbortEpoch.get(ruleId) ?? 0) + 1);
}

function isPollAborted(ruleId: string, epochAtStart: number): boolean {
  return (ruleAbortEpoch.get(ruleId) ?? 0) !== epochAtStart;
}

/** Only one Graph poll per rule at a time — avoids 429s when interval overlaps a slow run. */
const pollInFlight = new Set<string>();

export async function updateMonitoringRule(id: string, updates: Partial<MonitoringRule>) {
  const rules = await getMonitoringRules();
  const index = rules.findIndex(r => r.id === id);
  if (index === -1) throw new Error('Monitoring rule not found');
  if (updates.status === 'paused') {
    bumpMonitoringRuleAbort(id);
  }
  rules[index] = { ...rules[index], ...updates };
  await saveMonitoringRules(rules);
  return rules[index];
}

export async function deleteMonitoringRule(id: string) {
  bumpMonitoringRuleAbort(id);
  const rules = await getMonitoringRules();
  const filtered = rules.filter(r => r.id !== id);
  await saveMonitoringRules(filtered);
}

export async function toggleMonitoringRule(id: string) {
  const rules = await getMonitoringRules();
  const rule = rules.find(r => r.id === id);
  if (!rule) throw new Error('Monitoring rule not found');
  const newStatus = rule.status === 'active' ? 'paused' : 'active';
  return updateMonitoringRule(id, { status: newStatus });
}

// === Monitoring Alerts ===
export async function getMonitoringAlerts(): Promise<MonitoringAlert[]> {
  const alerts = await window.electron.store.get(ALERTS_STORE_KEY);
  return Array.isArray(alerts) ? alerts : [];
}

export async function saveMonitoringAlerts(alerts: MonitoringAlert[]) {
  await window.electron.store.set(ALERTS_STORE_KEY, alerts);
  window.dispatchEvent(new CustomEvent('monitoring-alerts-changed'));
}

export async function addMonitoringAlert(alert: Omit<MonitoringAlert, 'id'>) {
  const alerts = await getMonitoringAlerts();
  const newAlert: MonitoringAlert = {
    ...alert,
    id: crypto.randomUUID(),
  };
  alerts.push(newAlert);
  await saveMonitoringAlerts(alerts);
  const settings = await window.electron.store.get('settings');
  const tg = settings?.telegram?.monitoring;
  const isFolderOnly = alert.matchedKeyword === 'folder';
  const skipTelegramForKeywordSetting = Boolean(tg?.keywordOnly && isFolderOnly);

  if (tg?.enabled && !skipTelegramForKeywordSetting) {
    try {
      const accounts = await getAccounts();
      const account = accounts.find(a => a.id === alert.accountId);
      const email = account?.email || alert.accountId;
      const subj = escapeTelegramHtml(alert.subject || '(no subject)');
      const kw = escapeTelegramHtml(alert.matchedKeyword || '—');
      const acct = escapeTelegramHtml(email);
      const snip = alert.snippet?.trim()
        ? escapeTelegramHtml(alert.snippet.trim())
        : '—';
      const received = escapeTelegramHtml(formatLocalTime(alert.messageReceivedAt));
      const detected = escapeTelegramHtml(formatLocalTime(alert.timestamp));
      const rawLink = alert.webLink?.trim();
      const linkLine = rawLink
        ? `\n<a href="${rawLink.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">Open in Outlook</a>`
        : '';

      const message =
        `🚨 <b>Monitoring alert</b>\n` +
        `<b>Account:</b> ${acct}\n` +
        `<b>Keyword:</b> ${kw}\n` +
        `<b>Subject:</b> ${subj}\n` +
        `<b>Snippet:</b> ${snip}\n` +
        `<b>Received:</b> ${received}\n` +
        `<b>Detected:</b> ${detected}` +
        linkLine;

      const sendResult = await window.electron.actions.telegramSendAlert('monitoring', message);
      if (sendResult && !sendResult.success) {
        window.dispatchEvent(
          new CustomEvent('watcher-telegram-failed', {
            detail: { scope: 'monitoring', error: sendResult.error || 'Send failed' },
          })
        );
      }
    } catch (err) {
      console.error('Failed to send Telegram alert:', err);
      window.dispatchEvent(
        new CustomEvent('watcher-telegram-failed', {
          detail: { scope: 'monitoring', error: String(err) },
        })
      );
    }
  }
  return newAlert;
}

export async function markAlertRead(id: string) {
  const alerts = await getMonitoringAlerts();
  const index = alerts.findIndex(a => a.id === id);
  if (index === -1) throw new Error('Alert not found');
  alerts[index] = { ...alerts[index], read: true };
  await saveMonitoringAlerts(alerts);
  return alerts[index];
}

export async function markAllAlertsRead() {
  const alerts = await getMonitoringAlerts();
  const updated = alerts.map(a => ({ ...a, read: true }));
  await saveMonitoringAlerts(updated);
}

export async function deleteAlert(id: string) {
  const alerts = await getMonitoringAlerts();
  const filtered = alerts.filter(a => a.id !== id);
  await saveMonitoringAlerts(filtered);
}

export async function clearAlerts() {
  await saveMonitoringAlerts([]);
}

// === Monitoring Engine ===
let pollingInterval: NodeJS.Timeout | null = null;

export function startMonitoringPolling(intervalMinutes: number = 5) {
  stopMonitoringPolling();
  const intervalMs = intervalMinutes * 60 * 1000;
  pollingInterval = setInterval(async () => {
    console.log('Monitoring tick (running due interval)');
    try {
      const rules = await getMonitoringRules();
      const activeRules = rules.filter(r => r.status === 'active');
      for (const rule of activeRules) {
        await pollRule(rule);
      }
    } catch (err) {
      console.error('Monitoring polling error:', err);
    }
  }, intervalMs);
  console.log(`Monitoring polling scheduled every ${intervalMinutes} minutes`);
}

export function stopMonitoringPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

// Real panel API integration
async function pollRule(initialRule: MonitoringRule) {
  let rule = initialRule;
  if (rule.status !== 'active') {
    return;
  }
  if (pollInFlight.has(rule.id)) {
    console.log(`[Monitoring] Poll already in flight for rule ${rule.id} — skip (prevents Graph 429)`);
    return;
  }

  const epochAtStart = ruleAbortEpoch.get(rule.id) ?? 0;
  pollInFlight.add(rule.id);

  console.log(`[Monitoring] Polling rule ${rule.id} for account ${rule.accountId}`);
  try {
    if (isPollAborted(rule.id, epochAtStart)) {
      console.log(`[Monitoring] Rule ${rule.id} aborted before start`);
      return;
    }

    // 1. Fetch account (no panel needed)
    const accounts = await getAccounts();
    if (isPollAborted(rule.id, epochAtStart)) return;

    const account: UIAccount | undefined = accounts.find(a => a.id === rule.accountId);
    if (!account) {
      console.error(`[Monitoring] Account ${rule.accountId} not found`);
      return;
    }
    if (account.auth?.type !== 'token') {
      console.error(`[Monitoring] Account ${account.email} does not have token auth`);
      return;
    }
    if (account.status === 'expired') {
      console.warn(`[Monitoring] Account ${account.email} is expired, skipping`);
      return;
    }

    const rulesNow = await getMonitoringRules();
    const ruleLive = rulesNow.find(r => r.id === rule.id);
    if (!ruleLive || ruleLive.status !== 'active') {
      console.log(`[Monitoring] Rule ${rule.id} no longer active — stop poll`);
      return;
    }
    rule = ruleLive;

    // 2. Determine folders to monitor (empty = Inbox)
    const folderNames = rule.folders.length > 0 ? rule.folders : ['Inbox'];
    const keywords = rule.keywords || [];
    const since = computeMonitoringSince(rule);
    const fetchLimit = 40;

    const OutlookAPI = Outlook.getOutlookService();
    if (!OutlookAPI) {
      await updateMonitoringRule(rule.id, {
        lastError: 'Outlook API service unavailable',
        lastErrorAt: new Date().toISOString(),
      });
      return;
    }

    // Prefer a single listFolders call — recursive listing fans out to many Graph requests and triggers 429s.
    let folders: { id: string; displayName: string }[] = [];
    const folderEntryMatches = (
      list: { id: string; displayName: string }[],
      name: string
    ) =>
      list.some(
        f =>
          f.displayName.toLowerCase() === name.toLowerCase() ||
          f.id.toLowerCase() === name.toLowerCase()
      );
    try {
      const folderList = await OutlookAPI.listFolders(account);
      if (isPollAborted(rule.id, epochAtStart)) return;
      folders = folderList.map(f => ({ id: f.id, displayName: f.displayName }));
      const anyFolderMissing = folderNames.some(fn => !folderEntryMatches(folders, fn));
      if (anyFolderMissing) {
        try {
          const deep = await OutlookAPI.listAllFoldersRecursive(account);
          if (isPollAborted(rule.id, epochAtStart)) return;
          folders = deep.map(f => ({ id: f.id, displayName: f.displayName }));
        } catch {
          /* keep flat list */
        }
      }
    } catch (error: unknown) {
      if (isPollAborted(rule.id, epochAtStart)) return;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[Monitoring] listFolders failed for ${account.email}:`, msg);
      folders = [
        { id: 'inbox', displayName: 'Inbox' },
        { id: 'sent', displayName: 'Sent Items' },
        { id: 'drafts', displayName: 'Drafts' },
        { id: 'deleted', displayName: 'Deleted Items' },
      ];
    }

    if (isPollAborted(rule.id, epochAtStart)) return;

    const messages: any[] = [];
    const allAlerts = await getMonitoringAlerts();
    if (isPollAborted(rule.id, epochAtStart)) return;

    const seenForRule = new Set(
      allAlerts.filter(a => a.ruleId === rule.id && a.emailId).map(a => a.emailId as string)
    );

    for (const folderName of folderNames) {
      if (isPollAborted(rule.id, epochAtStart)) {
        console.log(`[Monitoring] Rule ${rule.id} aborted during folder fetch`);
        return;
      }
      try {
        const matchedFolder = folders.find(
          f =>
            f.displayName.toLowerCase() === folderName.toLowerCase() ||
            f.id.toLowerCase() === folderName.toLowerCase()
        );
        if (!matchedFolder) {
          console.warn(`[Monitoring] Folder "${folderName}" not found for ${account.email}, skipping`);
          continue;
        }
        const folderMessages = await OutlookAPI.fetchMessages(account, matchedFolder.id, since, fetchLimit);
        if (isPollAborted(rule.id, epochAtStart)) return;
        messages.push(...folderMessages.map((msg: any) => ({ ...msg, folder: folderName })));
      } catch (error: unknown) {
        if (isPollAborted(rule.id, epochAtStart)) return;
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[Monitoring] Failed to fetch messages from ${folderName}:`, msg);
        await updateMonitoringRule(rule.id, { lastError: `Fetch failed: ${msg}`, lastErrorAt: new Date().toISOString() });
      }
    }

    if (isPollAborted(rule.id, epochAtStart)) return;

    // 5. Evaluate each message against rule
    for (const msg of messages) {
      if (isPollAborted(rule.id, epochAtStart)) {
        console.log(`[Monitoring] Rule ${rule.id} aborted during message scan`);
        return;
      }

      const messageId = msg.id as string | undefined;
      if (messageId && seenForRule.has(messageId)) {
        continue;
      }

      if (!senderMatchesRule(msg, rule)) {
        continue;
      }

      let matched = false;
      let matchedKeyword = '';

      if (keywords.length === 0) {
        matched = true;
        matchedKeyword = '';
      } else {
        const text = (msg.subject || '') + ' ' + (msg.bodyPreview || '');
        const lowerText = text.toLowerCase();
        for (const kw of keywords) {
          if (kw && lowerText.includes(kw.toLowerCase())) {
            matched = true;
            matchedKeyword = kw;
            break;
          }
        }
      }

      if (matched) {
        console.log(`[Monitoring] Message matched! Subject: "${msg.subject}", Keyword: "${matchedKeyword}"`);
        try {
          const haystack = [(msg.subject || '').trim(), (msg.bodyPreview || '').trim()].filter(Boolean).join(' — ');
          const snippet =
            keywords.length === 0 || !matchedKeyword ?
              buildKeywordSnippet(haystack, '', SNIPPET_MAX)
            : buildKeywordSnippet(haystack, matchedKeyword, SNIPPET_MAX);

          if (isPollAborted(rule.id, epochAtStart)) return;

          const alert = await addMonitoringAlert({
            ruleId: rule.id,
            accountId: rule.accountId,
            emailId: messageId,
            subject: msg.subject || 'No subject',
            matchedKeyword: matchedKeyword || (keywords.length === 0 ? 'folder' : 'keyword'),
            timestamp: new Date().toISOString(),
            read: false,
            snippet: snippet || undefined,
            webLink: typeof msg.webLink === 'string' ? msg.webLink : undefined,
            messageReceivedAt: typeof msg.receivedDateTime === 'string' ? msg.receivedDateTime : undefined,
          });
          console.log(`[Monitoring] Alert created: ${alert.id}`);
          if (alert.emailId) seenForRule.add(alert.emailId);
          await updateMonitoringRule(rule.id, { lastAlert: new Date().toISOString() });
        } catch (alertError: any) {
          console.error(`[Monitoring] Failed to create alert:`, alertError.message);
        }
      }
    }

    if (isPollAborted(rule.id, epochAtStart)) return;

    // 6. Update last run timestamp
    await updateMonitoringRule(rule.id, { lastRun: new Date().toISOString() });
    console.log(`[Monitoring] Rule ${rule.id} polling completed successfully`);
  } catch (error: any) {
    if (isPollAborted(rule.id, epochAtStart)) {
      console.log(`[Monitoring] Rule ${rule.id} poll ended after abort`);
      return;
    }
    console.error(`[Monitoring] Polling rule ${rule.id} failed:`, error.message);
    await updateMonitoringRule(rule.id, { lastError: error.message, lastErrorAt: new Date().toISOString() });
  } finally {
    pollInFlight.delete(rule.id);
  }
}
// Debug helper (expose to window for console testing)
if (typeof window !== 'undefined') {
  (window as any).debugMonitoring = {
    async testRule(ruleId: string) {
      console.log('[Debug] Testing monitoring rule', ruleId);
      const rules = await getMonitoringRules();
      const rule = rules.find(r => r.id === ruleId);
      if (!rule) {
        console.error('Rule not found');
        return;
      }
      await pollRule(rule);
    },
    async testAllRules() {
      console.log('[Debug] Testing all monitoring rules');
      const rules = await getMonitoringRules();
      const activeRules = rules.filter(r => r.status === 'active');
      for (const rule of activeRules) {
        await pollRule(rule);
      }
    },
    async getRuleStatus(ruleId: string) {
      const rules = await getMonitoringRules();
      return rules.find(r => r.id === ruleId);
    },
    async getAlerts() {
      return await getMonitoringAlerts();
    },
    async clearAlerts() {
      await clearAlerts();
    }
  };

  // OAuth debug helpers
  (window as any).debugOAuth = {
    async deviceCode(clientId?: string, authority?: string) {
      console.log('[Debug] Starting device code flow');
      const result = await window.electron.oauth.deviceCode(clientId, authority);
      console.log('[Debug] Device code result:', result);
      if (result.success) {
        console.log(`\n📱 Go to: ${result.verificationUri}`);
        console.log(`🔢 Enter code: ${result.userCode}`);
        console.log(`⏱️  Code expires in: ${result.expiresIn} seconds`);
        console.log(`\n📋 Message: ${result.message}`);
        (window as any)._lastDeviceCode = result.deviceCode;
        (window as any)._lastClientId = clientId;
        (window as any)._lastAuthority = authority;
      }
      return result;
    },
    
    async pollToken(deviceCode?: string, clientId?: string, authority?: string) {
      const code = deviceCode || (window as any)._lastDeviceCode;
      const cid = clientId || (window as any)._lastClientId;
      const auth = authority || (window as any)._lastAuthority;
      
      if (!code) {
        console.error('[Debug] No device code available. Run deviceCode() first.');
        return;
      }
      
      console.log('[Debug] Polling for token...');
      const result = await window.electron.oauth.pollToken(code, cid, auth);
      console.log('[Debug] Poll result:', result);
      
      if (result.success) {
        console.log('✅ Token obtained successfully!');
        console.log(`🔑 Access token: ${result.accessToken.substring(0, 20)}...`);
        console.log(`🔄 Refresh token: ${result.refreshToken.substring(0, 20)}...`);
        console.log(`⏱️  Expires in: ${result.expiresIn} seconds`);
        console.log(`🎯 Scope: ${result.scope}`);
        (window as any)._lastTokenResult = result;
      } else if (result.pending) {
        console.log('⏳ Authorization pending...');
      } else if (result.expired) {
        console.error('❌ Device code expired. Run deviceCode() again.');
      }
      
      return result;
    },
    
    async addAccount(email: string, clientId?: string, authorityEndpoint?: string, refreshToken?: string, scopeType?: string) {
      const tokenResult = (window as any)._lastTokenResult;
      const cid = clientId || 'd3590ed6-52b3-4102-aeff-aad2292ab01c';
      const auth = authorityEndpoint || 'common';
      const token = refreshToken || (tokenResult ? tokenResult.refreshToken : null);
      const scope = scopeType || (tokenResult && tokenResult.scope.includes('EWS.AccessAsUser.All') ? 'ews' : 'graph');
      
      if (!token) {
        console.error('[Debug] No refresh token available. Run pollToken() first or provide refreshToken parameter.');
        return;
      }
      
      console.log(`[Debug] Adding account ${email} with scopeType: ${scope}`);
      const result = await window.electron.accounts.addViaToken(email, cid, auth, token, scope);
      console.log('[Debug] Account added:', result);
      return result;
    }
  };
}
