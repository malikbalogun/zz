import type { UIAccount } from '../../types/store';
import { getAccounts } from './accountService';
import { OutlookService, type OutlookMessage } from './outlookService';

export type ExportFormat = 'csv' | 'txt';

export type EmailExportScope =
  | 'current_folder'
  | 'all_folders_account'
  | 'selected_accounts_all_folders'
  | 'all_token_accounts';

export interface ExportRow {
  mailboxEmail: string;
  folderId: string;
  folderName: string;
  messageId: string;
  receivedDateTime: string;
  fromAddress: string;
  fromName: string;
  subject: string;
  bodyPreview: string;
  webLink: string;
}

function matchesFromFilter(msg: OutlookMessage, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  const addr = msg.from?.emailAddress?.address?.toLowerCase() || '';
  const name = msg.from?.emailAddress?.name?.toLowerCase() || '';
  return addr.includes(f) || name.includes(f);
}

function toRow(mailboxEmail: string, folderId: string, folderName: string, msg: OutlookMessage): ExportRow {
  return {
    mailboxEmail,
    folderId,
    folderName,
    messageId: msg.id,
    receivedDateTime: msg.receivedDateTime,
    fromAddress: msg.from?.emailAddress?.address || '',
    fromName: msg.from?.emailAddress?.name || '',
    subject: msg.subject || '',
    bodyPreview: (msg.bodyPreview || '').replace(/\r?\n/g, ' '),
    webLink: msg.webLink || '',
  };
}

const GLOBAL_ROW_CAP = 400_000;

export async function collectMessagesForExport(opts: {
  scope: EmailExportScope;
  primaryAccount: UIAccount;
  primaryFolderId: string;
  primaryFolderName: string;
  selectedAccountIds: string[];
  maxPerFolder: number;
  fromFilter: string;
  onProgress?: (label: string, countSoFar: number) => void;
}): Promise<ExportRow[]> {
  const { scope, primaryAccount, primaryFolderId, primaryFolderName, maxPerFolder, fromFilter, onProgress } = opts;
  const filter = fromFilter;
  const rows: ExportRow[] = [];
  const seen = new Set<string>();
  const maxPer = Math.min(Math.max(maxPerFolder, 10), 50_000);

  const appendMessages = (
    account: UIAccount,
    folderId: string,
    folderName: string,
    msgs: OutlookMessage[]
  ) => {
    for (const m of msgs) {
      if (rows.length >= GLOBAL_ROW_CAP) return;
      if (!m.id) continue;
      if (!matchesFromFilter(m, filter)) continue;
      const key = `${account.id}:${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(toRow(account.email, folderId, folderName, m));
    }
  };

  const walkAllFolders = async (account: UIAccount) => {
    const folders = await OutlookService.listAllFoldersRecursive(account);
    for (const folder of folders) {
      if (rows.length >= GLOBAL_ROW_CAP) break;
      onProgress?.(`${account.email} — ${folder.displayName}`, rows.length);
      try {
        const msgs = await OutlookService.fetchAllMessagesInFolderPaginated(account, folder.id, {
          maxPerFolder: maxPer,
          pageSize: 100,
        });
        appendMessages(account, folder.id, folder.displayName, msgs);
      } catch (err) {
        console.warn(`[Export] Skip folder ${folder.displayName}:`, err);
      }
    }
  };

  if (scope === 'current_folder') {
    onProgress?.(`${primaryAccount.email} — ${primaryFolderName}`, 0);
    const msgs = await OutlookService.fetchAllMessagesInFolderPaginated(primaryAccount, primaryFolderId, {
      maxPerFolder: maxPer,
      pageSize: 100,
    });
    appendMessages(primaryAccount, primaryFolderId, primaryFolderName, msgs);
    return rows;
  }

  if (scope === 'all_folders_account') {
    await walkAllFolders(primaryAccount);
    return rows;
  }

  let targets: UIAccount[];
  if (scope === 'selected_accounts_all_folders') {
    const idSet = new Set(opts.selectedAccountIds);
    const all = await getAccounts();
    targets = all.filter(a => a.auth?.type === 'token' && a.status === 'active' && idSet.has(a.id));
  } else {
    const all = await getAccounts();
    targets = all.filter(a => a.auth?.type === 'token' && a.status === 'active');
  }

  for (const account of targets) {
    if (rows.length >= GLOBAL_ROW_CAP) break;
    await walkAllFolders(account);
  }

  return rows;
}

export function formatExportCsv(rows: ExportRow[]): string {
  const headers = [
    'mailbox',
    'folder_name',
    'folder_id',
    'received',
    'from_email',
    'from_name',
    'subject',
    'body_preview',
    'message_id',
    'web_link',
  ];
  const esc = (v: string) => {
    const s = String(v ?? '').replace(/\r?\n/g, ' ');
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(
      [
        esc(r.mailboxEmail),
        esc(r.folderName),
        esc(r.folderId),
        esc(r.receivedDateTime),
        esc(r.fromAddress),
        esc(r.fromName),
        esc(r.subject),
        esc(r.bodyPreview),
        esc(r.messageId),
        esc(r.webLink),
      ].join(',')
    );
  }
  return lines.join('\n');
}

export function formatExportTxt(rows: ExportRow[]): string {
  const blocks: string[] = [];
  for (const r of rows) {
    blocks.push(
      [
        `Mailbox: ${r.mailboxEmail}`,
        `Folder: ${r.folderName}`,
        `Received: ${r.receivedDateTime}`,
        `From: ${r.fromName} <${r.fromAddress}>`,
        `Subject: ${r.subject}`,
        `Preview: ${r.bodyPreview}`,
        `Link: ${r.webLink}`,
        `MessageId: ${r.messageId}`,
        '---',
      ].join('\n')
    );
  }
  return blocks.join('\n');
}

export async function saveExportWithDialog(content: string, format: ExportFormat): Promise<{ ok: boolean; path?: string }> {
  const ext = format === 'csv' ? 'csv' : 'txt';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const result = await window.electron.files.saveTextWithDialog({
    defaultFilename: `email-export-${stamp}.${ext}`,
    content,
    filters:
      format === 'csv'
        ? [{ name: 'CSV', extensions: ['csv'] }]
        : [{ name: 'Plain text', extensions: ['txt'] }],
  });
  if (!result.ok) return { ok: false };
  return { ok: true, path: result.path };
}
