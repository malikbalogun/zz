import { getSettings } from './settingsService';
import { getPanels } from './panelService';
import { getAccounts } from './accountService';
import { syncPanelAccounts } from './accountSyncService';
import { refreshAccountToken } from './accountSyncService';
import { startMonitoringPolling, stopMonitoringPolling } from './monitoringService';
import { runSecurityRulesBatch } from './securityRuleRunner';
import { runAutoReplyBatch } from './autoReplyRunner';

let syncInterval: NodeJS.Timeout | null = null;
let refreshInterval: NodeJS.Timeout | null = null;
let securityRulesInterval: NodeJS.Timeout | null = null;
let autoReplyInterval: NodeJS.Timeout | null = null;

export function startBackgroundScheduler() {
  stopBackgroundScheduler(); // clear any existing intervals

  // Load settings
  getSettings().then(settings => {
    // Auto‑sync interval
    if (settings.sync.autoSync && settings.sync.intervalMinutes > 0) {
      const intervalMs = settings.sync.intervalMinutes * 60 * 1000;
      syncInterval = setInterval(async () => {
        console.log('Background panel sync started');
        try {
          const panels = await getPanels();
          for (const panel of panels.filter(p => p.status === 'connected')) {
            try {
              await syncPanelAccounts(panel.id);
              console.log(`Synced panel ${panel.name}`);
            } catch (err) {
              console.error(`Panel sync failed for ${panel.name}:`, err);
            }
          }
        } catch (err) {
          console.error('Background sync error:', err);
        }
      }, intervalMs);
      console.log(`Auto‑sync scheduled every ${settings.sync.intervalMinutes} minutes`);
    }

    // Auto‑refresh interval
    if (settings.refresh.autoRefresh && settings.refresh.intervalMinutes > 0) {
      const intervalMs = settings.refresh.intervalMinutes * 60 * 1000;
      refreshInterval = setInterval(async () => {
        console.log('Background token refresh started');
        try {
          const accounts = await getAccounts();
          const autorefreshTag = settings.refresh.tagId || 'autorefresh';
          const accountsToRefresh = accounts.filter(acc => 
            acc.tags.includes(autorefreshTag) && acc.status === 'active'
          );
          for (const account of accountsToRefresh) {
            try {
              await refreshAccountToken(account.id);
              console.log(`Refreshed token for ${account.email}`);
            } catch (err) {
              console.error(`Token refresh failed for ${account.email}:`, err);
            }
          }
        } catch (err) {
          console.error('Background refresh error:', err);
        }
      }, intervalMs);
      console.log(`Auto‑refresh scheduled every ${settings.refresh.intervalMinutes} minutes`);
    }

    // Monitoring polling interval
    if (settings.monitoring.enabled && settings.monitoring.intervalMinutes > 0) {
      stopMonitoringPolling(); // ensure no duplicate interval
      startMonitoringPolling(settings.monitoring.intervalMinutes);
      console.log(`Monitoring polling scheduled every ${settings.monitoring.intervalMinutes} minutes`);
    }

    // Security rules (Inbox): junk / delete / read on matching mail
    const sec = settings.security;
    const secMins = sec?.autoApplyIntervalMinutes ?? 0;
    if (sec?.filterEnabled !== false && secMins > 0) {
      const intervalMs = secMins * 60 * 1000;
      securityRulesInterval = setInterval(() => {
        void runSecurityRulesBatch().catch(err => console.error('Security rules interval failed:', err));
      }, intervalMs);
      console.log(`Security rules auto-apply scheduled every ${secMins} minutes`);
    }

    const ar = settings.autoReply;
    const arMins = ar?.intervalMinutes ?? 0;
    if (ar?.engineEnabled === true && arMins > 0) {
      const intervalMs = arMins * 60 * 1000;
      autoReplyInterval = setInterval(() => {
        void runAutoReplyBatch().catch(err => console.error('Auto-reply interval failed:', err));
      }, intervalMs);
      console.log(`Auto-reply engine scheduled every ${arMins} minutes`);
    }
  }).catch(err => {
    console.error('Failed to load settings for background scheduler:', err);
  });
}

export function stopBackgroundScheduler() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  if (securityRulesInterval) {
    clearInterval(securityRulesInterval);
    securityRulesInterval = null;
  }
  if (autoReplyInterval) {
    clearInterval(autoReplyInterval);
    autoReplyInterval = null;
  }
  stopMonitoringPolling();
}

/** Re-read settings and reschedule intervals (call after changing security/sync/monitoring settings). */
export function restartBackgroundScheduler() {
  stopBackgroundScheduler();
  startBackgroundScheduler();
}