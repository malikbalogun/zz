import type { SearchJob, SearchResult, UIAccount } from '../../types/store';
import { getAccounts } from './accountService';
import * as Outlook from './outlookService';
const QUEUE_STORE_KEY = 'searchQueue';
const RESULTS_STORE_KEY = 'searchResults';

// === Search Queue ===
export async function getSearchQueue(): Promise<SearchJob[]> {
  const queue = await window.electron.store.get(QUEUE_STORE_KEY);
  return Array.isArray(queue) ? queue : [];
}

export async function saveSearchQueue(queue: SearchJob[]) {
  await window.electron.store.set(QUEUE_STORE_KEY, queue);
}

export async function addSearchJob(job: Omit<SearchJob, 'id' | 'createdAt' | 'status'>) {
  const queue = await getSearchQueue();
  const newJob: SearchJob = {
    ...job,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'queued',
  };
  queue.push(newJob);
  await saveSearchQueue(queue);
  return newJob;
}

export async function updateSearchJob(id: string, updates: Partial<SearchJob>) {
  const queue = await getSearchQueue();
  const index = queue.findIndex(j => j.id === id);
  if (index === -1) throw new Error('Search job not found');
  queue[index] = { ...queue[index], ...updates };
  await saveSearchQueue(queue);
  return queue[index];
}

export async function deleteSearchJob(id: string) {
  const queue = await getSearchQueue();
  const filtered = queue.filter(j => j.id !== id);
  await saveSearchQueue(filtered);
}

export async function clearSearchQueue() {
  await saveSearchQueue([]);
}

// === Search Results ===
export async function getSearchResults(): Promise<SearchResult[]> {
  const results = await window.electron.store.get(RESULTS_STORE_KEY);
  return Array.isArray(results) ? results : [];
}

export async function saveSearchResults(results: SearchResult[]) {
  await window.electron.store.set(RESULTS_STORE_KEY, results);
}

export async function addSearchResult(result: Omit<SearchResult, 'id'>) {
  const results = await getSearchResults();
  const newResult: SearchResult = {
    ...result,
    id: crypto.randomUUID(),
  };
  results.push(newResult);
  await saveSearchResults(results);
  return newResult;
}

export async function deleteSearchResult(id: string) {
  const results = await getSearchResults();
  const filtered = results.filter(r => r.id !== id);
  await saveSearchResults(filtered);
}

export async function clearSearchResults() {
  await saveSearchResults([]);
}

// === Search Engine ===
let currentJobId: string | null = null;

/** If both dates exist and From > To (common mistake), swap so the range is valid. */
export function normalizeDateRange(range: { start?: string; end?: string }): { start?: string; end?: string } {
  const s = range.start?.trim();
  const e = range.end?.trim();
  if (!s && !e) return {};
  if (!s) return { end: e };
  if (!e) return { start: s };
  if (s <= e) return { start: s, end: e };
  return { start: e, end: s };
}

function messageInDateRange(receivedIso: string, range: { start?: string; end?: string }): boolean {
  const r = normalizeDateRange(range);
  if (!r.start && !r.end) return true;
  const msgDate = new Date(receivedIso);
  const t = msgDate.getTime();
  if (Number.isNaN(t)) return true;
  if (r.start) {
    const start = new Date(r.start + 'T00:00:00');
    if (t < start.getTime()) return false;
  }
  if (r.end) {
    const end = new Date(r.end + 'T23:59:59.999');
    if (t > end.getTime()) return false;
  }
  return true;
}

function messageMatchesSender(
  msg: { from?: { emailAddress?: { address?: string } } },
  filter: string | undefined
): boolean {
  if (!filter?.trim()) return true;
  const from = (msg.from?.emailAddress?.address || '').toLowerCase();
  return from.includes(filter.trim().toLowerCase());
}

export async function runSearchJob(id: string) {
  if (currentJobId) {
    throw new Error('Another search is already running');
  }
  currentJobId = id;
  try {
    await updateSearchJob(id, { status: 'running' });
    const queueFresh = await getSearchQueue();
    const job = queueFresh.find(j => j.id === id);
    if (!job) {
      throw new Error('Search job not found');
    }
    const dateRange = normalizeDateRange(job.dateRange || {});
    if (
      job.dateRange?.start &&
      job.dateRange?.end &&
      job.dateRange.start > job.dateRange.end
    ) {
      console.warn(
        `[Search] Job ${id}: date From was after To — using ${dateRange.start} … ${dateRange.end}`
      );
    }
    
    // 1. Load accounts (no panels needed)
    const accounts = await getAccounts();
    const results: SearchResult[] = [];
    const OutlookAPI = Outlook.getOutlookService();
    if (!OutlookAPI) {
      console.error('[Search] getOutlookService is undefined, cannot run search');
      await updateSearchJob(id, { status: 'failed', lastError: 'Outlook API service unavailable' });
      return [];
    }
    // 2. Process each account sequentially
    for (const accountId of job.accountIds) {
      const account: UIAccount | undefined = accounts.find(a => a.id === accountId);
      if (!account) {
        console.warn(`[Search] Account ${accountId} not found`);
        continue;
      }
      if (account.auth?.type !== 'token') {
        console.warn(`[Search] Account ${account.email} does not have token auth`);
        continue;
      }
      if (account.status === 'expired') {
        console.warn(`[Search] Account ${account.email} is expired, skipping`);
        continue;
      }

      const folderIdToName = new Map<string, string>();

      // 3. Determine folder IDs if folders specified
      let folderIds: string[] = [];
      if (job.folders && job.folders.length > 0) {
        try {
          const folderList = await OutlookAPI.listFolders(account);
          for (const f of folderList) {
            folderIdToName.set(f.id, f.displayName);
          }
          const displayAliases: Record<string, string[]> = {
            inbox: ['inbox'],
            sent: ['sent items', 'sentitems', 'sent'],
            drafts: ['drafts'],
            deleted: ['deleted items', 'deleteditems', 'deleted'],
            junk: ['junk email', 'junkemail', 'junk'],
          };
          for (const folderName of job.folders) {
            const key = folderName.toLowerCase().trim();
            const aliases = displayAliases[key] || [key];
            const matched = folderList.find(f => {
              const dn = f.displayName.toLowerCase();
              const id = f.id.toLowerCase();
              return aliases.some(a => dn === a || id === a || dn === key || id === key);
            });
            if (matched) {
              folderIds.push(matched.id);
            } else {
              console.warn(`[Search] Folder "${folderName}" not found for ${account.email}, skipping`);
            }
          }
        } catch (error: any) {
          console.error(`[Search] Failed to list folders for ${account.email}:`, error.message);
          folderIds = job.folders.map(name => name.toLowerCase());
        }
      }

      // 4. Build search query from keywords
      const query = job.keywords.join(' ').replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
      if (!query) {
        console.warn(`[Search] Empty query for job ${id}, skipping`);
        continue;
      }

      const folderLabels: string[] =
        folderIds.length === 0
          ? ['All folders']
          : folderIds.map(fid => folderIdToName.get(fid) || fid);

      // 5. Search in each folder (or across entire mailbox)
      const searchPromises: Promise<any[]>[] = [];
      // Outlook search follows @odata.nextLink (see outlookService.searchMessages) up to cap.
      if (folderIds.length === 0) {
        searchPromises.push(OutlookAPI.searchMessages(account, query));
      } else {
        for (const folderId of folderIds) {
          searchPromises.push(OutlookAPI.searchMessages(account, query, folderId));
        }
      }

      const searchResultsArrays = await Promise.allSettled(searchPromises);
      let apiHits = 0;
      const countBeforeAccount = results.length;
      for (let i = 0; i < searchResultsArrays.length; i++) {
        const settled = searchResultsArrays[i];
        if (settled.status === 'rejected') {
          console.error(`[Search] Search failed for folder ${folderLabels[i] || 'all'}:`, settled.reason);
          continue;
        }
        const messages = settled.value;
        apiHits += messages.length;
        for (const msg of messages) {
          const received = msg.receivedDateTime || new Date().toISOString();
          if (!messageInDateRange(received, dateRange)) {
            continue;
          }
          if (!messageMatchesSender(msg, job.senderFilter)) {
            continue;
          }
          const searchResult: Omit<SearchResult, 'id'> = {
            jobId: id,
            accountId: account.id,
            subject: msg.subject || 'No subject',
            snippet: msg.bodyPreview || '',
            date: received,
            folder: folderLabels[i] || 'All folders',
            keywords: job.keywords,
            webLink: typeof msg.webLink === 'string' ? msg.webLink : undefined,
            emailId: typeof msg.id === 'string' ? msg.id : undefined,
          };
          const saved = await addSearchResult(searchResult);
          results.push(saved);
        }
      }
      console.log(
        `[Search] Account ${account.email}: ${apiHits} API hits, ${results.length - countBeforeAccount} kept (date/sender filters)`
      );

      // Small delay between accounts to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // 7. Update job status
    await updateSearchJob(id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      results,
    });
    
    // 8. Optionally send Telegram summary (Settings → Telegram → Account Search: token/chatId + enabled; not monitoring)
    const settings = await window.electron.store.get('settings');
    const searchTg = settings?.telegram?.search;
    const wantTg = job.telegramAlert && results.length > 0;
    if (wantTg && !searchTg?.enabled) {
      console.warn(
        '[Search] Notify via Telegram is on for this job, but Account Search Telegram is disabled in Settings → Telegram.'
      );
    } else if (wantTg && (!searchTg?.token?.trim() || !searchTg?.chatId?.trim())) {
      console.warn(
        '[Search] Notify via Telegram is on, but Account Search bot token / chat ID are missing in Settings → Telegram (separate from Monitoring).'
      );
    }
    if (job.telegramAlert && searchTg?.enabled && results.length > 0) {
      try {
        const tgRes = await window.electron.actions.telegramSendSearchResults('search', results);
        if (tgRes && !tgRes.success) {
          window.dispatchEvent(
            new CustomEvent('watcher-telegram-failed', {
              detail: { scope: 'search', error: tgRes.error || 'Telegram send failed' },
            })
          );
        }
      } catch (err) {
        console.error('[Search] Failed to send Telegram search results:', err);
        window.dispatchEvent(
          new CustomEvent('watcher-telegram-failed', {
            detail: { scope: 'search', error: String(err) },
          })
        );
      }
    }
    
    return results;
  } catch (error: any) {
    console.error(`[Search] Job ${id} failed:`, error.message);
    await updateSearchJob(id, { status: 'failed', lastError: error.message });
    throw error;
  } finally {
    currentJobId = null;
  }
}

export async function runAllQueuedJobs() {
  await clearSearchResults();
  const queue = await getSearchQueue();
  const queued = queue.filter(j => j.status === 'queued');
  for (const job of queued) {
    await runSearchJob(job.id);
  }
}

// Debug helper (expose to window for console testing)
if (typeof window !== 'undefined') {
  (window as any).debugSearch = {
    async getQueue() {
      return await getSearchQueue();
    },
    async createTestJob(accountIds?: string[]) {
      const accounts = await getAccounts();
      const ids = accountIds || [accounts[0]?.id];
      if (!ids[0]) {
        console.error('No accounts available');
        return;
      }
      const job = await addSearchJob({
        accountIds: ids,
        keywords: ['test'],
        folders: [],
        dateRange: {},
        telegramAlert: false,
      });
      console.log('[Debug] Created test search job:', job.id);
      return job;
    },
    async runJob(jobId: string) {
      await runSearchJob(jobId);
    },
    async getResults() {
      return await getSearchResults();
    },
    async clearQueue() {
      await clearSearchQueue();
    },
    async clearResults() {
      await clearSearchResults();
    }
  };
}