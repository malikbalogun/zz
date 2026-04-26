import type { UIAccount } from '../../types/store';
import { refreshMicrosoftToken } from './microsoftTokenService';
import { getSettings } from './settingsService';

export interface OutlookRecipient {
  emailAddress: { address?: string; name?: string };
}

export interface OutlookMessage {
  id: string;
  subject?: string;
  bodyPreview?: string;
  webLink?: string;
  receivedDateTime: string;
  from?: { emailAddress: { address?: string; name?: string } };
  /** Present when API returns recipient lists (contact extraction). */
  toRecipients?: OutlookRecipient[];
  ccRecipients?: OutlookRecipient[];
  bccRecipients?: OutlookRecipient[];
  folderId?: string;
  /** Outlook conversation/thread id (for auto-reply / thread rules). */
  conversationId?: string;
}

export interface OutlookFolder {
  id: string;
  displayName: string;
  totalItemCount: number;
  unreadItemCount: number;
}

export interface OutlookSearchResult {
  id: string;
  subject?: string;
  bodyPreview?: string;
  webLink?: string;
  receivedDateTime: string;
  from?: { emailAddress: { address?: string } };
  folderId?: string;
}

/**
 * OData segment for MailFolders. Must use the exact Id string from the API for opaque IDs
 * (e.g. AQMkADAw...); never change casing except for well-known short names.
 */
function mailFolderPathSegment(folderId: string): string {
  const raw = folderId.trim();
  if (!raw) return "MailFolders('Inbox')";
  const lower = raw.toLowerCase();
  const wellKnown: Record<string, string> = {
    inbox: 'Inbox',
    sentitems: 'SentItems',
    sent: 'SentItems',
    deleteditems: 'DeletedItems',
    deleted: 'DeletedItems',
    drafts: 'Drafts',
    junkemail: 'JunkEmail',
    junk: 'JunkEmail',
    archive: 'Archive',
    outbox: 'Outbox',
  };
  if (wellKnown[lower]) {
    return `MailFolders('${wellKnown[lower]}')`;
  }
  const escaped = raw.replace(/'/g, "''");
  return `MailFolders('${escaped}')`;
}

function mapFolder(f: Record<string, unknown>) {
  const rec = f as Record<string, any>;
  return {
    id: rec.Id ?? rec.id ?? '',
    displayName: rec.DisplayName ?? rec.displayName ?? 'Folder',
    totalItemCount: rec.TotalItemCount ?? rec.totalItemCount ?? rec.TotalCount ?? 0,
    unreadItemCount: rec.UnreadItemCount ?? rec.unreadItemCount ?? 0,
  };
}

function mapOneRecipient(r: Record<string, any> | undefined): OutlookRecipient | null {
  if (!r) return null;
  const ea = r.EmailAddress ?? r.emailAddress;
  const addr = ea?.Address ?? ea?.address;
  if (!addr || typeof addr !== 'string') return null;
  const name = ea?.Name ?? ea?.name;
  return { emailAddress: { address: addr, ...(name ? { name } : {}) } };
}

function mapRecipientList(raw: unknown): OutlookRecipient[] {
  if (!Array.isArray(raw)) return [];
  const out: OutlookRecipient[] = [];
  for (const r of raw) {
    const m = mapOneRecipient(r as Record<string, any>);
    if (m) out.push(m);
  }
  return out;
}

function mapMessage(msg: Record<string, any>) {
  const from =
    msg.From ?? msg.from ?? msg.Sender ?? msg.sender;
  const addr = from?.EmailAddress?.Address ?? from?.emailAddress?.address;
  const fromName = from?.EmailAddress?.Name ?? from?.emailAddress?.name;
  return {
    id: msg.Id ?? msg.id,
    subject: msg.Subject ?? msg.subject,
    bodyPreview: msg.BodyPreview ?? msg.bodyPreview,
    webLink: msg.WebLink ?? msg.webLink,
    receivedDateTime: msg.ReceivedDateTime ?? msg.receivedDateTime,
    from: addr ? { emailAddress: { address: addr, ...(fromName ? { name: fromName } : {}) } } : undefined,
    toRecipients: mapRecipientList(msg.ToRecipients ?? msg.toRecipients),
    ccRecipients: mapRecipientList(msg.CcRecipients ?? msg.ccRecipients),
    bccRecipients: mapRecipientList(msg.BccRecipients ?? msg.bccRecipients),
    folderId: msg.ParentFolderId ?? msg.parentFolderId,
    conversationId: msg.ConversationId ?? msg.conversationId,
  };
}

/**
 * Outlook REST API service (EWS scope).
 * Uses locally stored tokens (via refresh) to call Outlook REST endpoints.
 * Assumes token has scope: https://outlook.office.com/EWS.AccessAsUser.All offline_access
 */
export class OutlookService {
  private static baseUrl = 'https://outlook.office.com/api/v2.0';

  /**
   * Get a fresh access token for an account.
   * Refreshes if necessary.
   */
  static async getAccessToken(account: UIAccount): Promise<string> {
    console.log('[Outlook] getAccessToken called for', account.email);
    if (account.auth?.type !== 'token') {
      throw new Error(`Account ${account.email} does not have token auth`);
    }
    const { clientId, authorityEndpoint, refreshToken } = account.auth;
    if (!clientId || !authorityEndpoint || !refreshToken) {
      throw new Error(`Missing auth fields for ${account.email}`);
    }
    console.log('[Outlook] Calling refreshMicrosoftToken via IPC');
    const result = await refreshMicrosoftToken(
      clientId,
      authorityEndpoint,
      refreshToken,
      account.auth.scopeType || 'ews',
      account.auth.resource
    );
    console.log('[Outlook] Got access token, expires in', result.expiresIn);
    return result.accessToken;
  }

  /**
   * List all mailbox folders for an account.
   */
  static async listFolders(account: UIAccount): Promise<OutlookFolder[]> {
    const token = await this.getAccessToken(account);
    const response = await fetch(`${this.baseUrl}/me/MailFolders?$top=200`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Outlook listFolders failed: ${response.status} ${await response.text()}`);
    }
    const data = await response.json();
    const rows = Array.isArray(data.value) ? data.value : [];
    return rows.map((f: Record<string, unknown>) => mapFolder(f));
  }

  /** All folders including nested (Sent, Deleted, subfolders under Inbox, etc.). */
  static async listAllFoldersRecursive(account: UIAccount): Promise<OutlookFolder[]> {
    const token = await this.getAccessToken(account);
    const baseUrl = this.baseUrl;
    const collected: OutlookFolder[] = [];
    const seen = new Set<string>();

    const fetchRows = async (url: string): Promise<Record<string, unknown>[]> => {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error(`Outlook folder fetch failed: ${response.status} ${await response.text()}`);
      }
      const data = await response.json();
      return Array.isArray(data.value) ? data.value : [];
    };

    const walk = async (rows: Record<string, unknown>[]) => {
      for (const raw of rows) {
        const f = mapFolder(raw);
        if (!f.id || seen.has(f.id)) continue;
        seen.add(f.id);
        collected.push(f);
        try {
          const childUrl = `${baseUrl}/me/${mailFolderPathSegment(f.id)}/ChildFolders?$top=200`;
          const children = await fetchRows(childUrl);
          await walk(children);
        } catch (err) {
          console.warn(`[Outlook] Skipping child folders for ${f.displayName}:`, err);
        }
      }
    };

    const root = await fetchRows(`${baseUrl}/me/MailFolders?$top=200`);
    await walk(root);
    return collected;
  }

  /** Fields needed to harvest every address on a message (From + To + Cc + Bcc). */
  private static readonly CONTACT_MESSAGE_SELECT =
    'Id,Subject,BodyPreview,WebLink,ReceivedDateTime,From,Sender,ToRecipients,CcRecipients,BccRecipients,ParentFolderId,ConversationId';

  /**
   * Walk all pages in a folder until maxPerFolder messages or no @odata.nextLink.
   */
  static async fetchAllMessagesInFolderPaginated(
    account: UIAccount,
    folderId: string,
    opts?: { maxPerFolder?: number; pageSize?: number }
  ): Promise<OutlookMessage[]> {
    const maxPerFolder = opts?.maxPerFolder ?? 10000;
    const pageSize = Math.min(Math.max(opts?.pageSize ?? 100, 10), 200);
    const collected: OutlookMessage[] = [];
    const folderPath = mailFolderPathSegment(folderId);
    const params = new URLSearchParams();
    params.set('$top', String(pageSize));
    params.set('$orderby', 'ReceivedDateTime desc');
    params.set('$select', this.CONTACT_MESSAGE_SELECT);
    let url: string | null = `${this.baseUrl}/me/${folderPath}/messages?${params.toString()}`;

    while (url && collected.length < maxPerFolder) {
      const token = await this.getAccessToken(account);
      let response!: Response;
      for (let attempt = 0; attempt < 5; attempt++) {
        response = await fetch(url!, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });
        if (response.status === 429 && attempt < 4) {
          const ra = parseInt(response.headers.get('Retry-After') || '3', 10);
          await new Promise(r =>
            setTimeout(r, Math.min((Number.isFinite(ra) ? ra : 3) * 1000, 120000))
          );
          continue;
        }
        break;
      }
      const errText = await response.text();
      if (!response.ok) {
        throw new Error(`Outlook paginated fetch failed: ${response.status} ${errText}`);
      }
      let data: Record<string, any>;
      try {
        data = JSON.parse(errText);
      } catch {
        throw new Error('Outlook paginated fetch: invalid JSON');
      }
      const rows = Array.isArray(data.value) ? data.value : [];
      for (const row of rows) {
        if (collected.length >= maxPerFolder) break;
        collected.push(mapMessage(row as Record<string, any>));
      }
      const nextLink =
        (data['@odata.nextLink'] as string | undefined) ||
        (data['odata.nextLink'] as string | undefined);
      url = nextLink || null;
      if (url && collected.length < maxPerFolder) {
        await new Promise(r => setTimeout(r, 40));
      }
    }
    return collected;
  }

  /**
   * Pull messages from many folders for contact extraction (Inbox, Sent, Deleted, subfolders, etc.).
   * Uses pagination per folder and loads From / To / Cc / Bcc on each message.
   */
  static async fetchMessagesForContactExtraction(
    account: UIAccount,
    opts?: {
      perFolder?: number;
      maxMessages?: number;
      pageSize?: number;
      onProgress?: (p: {
        phase: 'listing' | 'folders' | 'done';
        folderName?: string;
        foldersDone: number;
        foldersTotal: number;
        messagesCollected: number;
      }) => void;
    }
  ): Promise<OutlookMessage[]> {
    const perFolderMax = opts?.perFolder ?? 8000;
    const maxMessages = opts?.maxMessages ?? 100000;
    const pageSize = opts?.pageSize ?? 100;
    opts?.onProgress?.({
      phase: 'listing',
      foldersDone: 0,
      foldersTotal: 0,
      messagesCollected: 0,
    });
    const folders = await this.listAllFoldersRecursive(account);
    const out: OutlookMessage[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i];
      opts?.onProgress?.({
        phase: 'folders',
        folderName: folder.displayName,
        foldersDone: i,
        foldersTotal: folders.length,
        messagesCollected: out.length,
      });
      if (out.length >= maxMessages) break;
      try {
        const budget = Math.min(perFolderMax, maxMessages - out.length);
        if (budget <= 0) break;
        const msgs = await this.fetchAllMessagesInFolderPaginated(account, folder.id, {
          maxPerFolder: budget,
          pageSize,
        });
        for (const m of msgs) {
          if (!m.id || seen.has(m.id)) continue;
          seen.add(m.id);
          out.push(m);
          if (out.length >= maxMessages) break;
        }
        opts?.onProgress?.({
          phase: 'folders',
          folderName: folder.displayName,
          foldersDone: i + 1,
          foldersTotal: folders.length,
          messagesCollected: out.length,
        });
      } catch (err) {
        console.warn(`[Outlook] Skipping folder ${folder.displayName}:`, err);
        opts?.onProgress?.({
          phase: 'folders',
          folderName: folder.displayName,
          foldersDone: i + 1,
          foldersTotal: folders.length,
          messagesCollected: out.length,
        });
      }
    }
    opts?.onProgress?.({
      phase: 'done',
      foldersDone: folders.length,
      foldersTotal: folders.length,
      messagesCollected: out.length,
    });
    return out;
  }

  /**
   * Fetch messages from a specific folder.
   * @param account Account object with token auth.
   * @param folderId Folder ID (or 'inbox' for default Inbox).
   * @param since Optional ISO date string to fetch messages after.
   * @param limit Max number of messages (default 50).
   */
  static async fetchMessages(
    account: UIAccount,
    folderId: string = 'inbox',
    since?: string,
    limit: number = 50
  ): Promise<OutlookMessage[]> {
    const maxAttempts = 4;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const token = await this.getAccessToken(account);
        const folderPath = mailFolderPathSegment(folderId);
        let url = `${this.baseUrl}/me/${folderPath}/messages`;
        const params = new URLSearchParams();
        params.append('$top', limit.toString());
        params.append('$orderby', 'ReceivedDateTime desc');
        params.append(
          '$select',
          'Id,Subject,BodyPreview,WebLink,ReceivedDateTime,From,ParentFolderId,ConversationId'
        );

        if (since) {
          params.append('$filter', `ReceivedDateTime ge ${since}`);
        }
        url += '?' + params.toString();

        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });
        const errText = await response.text();
        if (!response.ok) {
          const is429 = response.status === 429;
          const retryAfterSec = is429
            ? parseInt(response.headers.get('Retry-After') || '', 10)
            : NaN;
          const wait429ms =
            Number.isFinite(retryAfterSec) && retryAfterSec > 0
              ? Math.min(retryAfterSec * 1000, 120000)
              : 3000 * (attempt + 1);

          const transient =
            is429 ||
            response.status === 503 ||
            response.status === 502 ||
            response.status === 504 ||
            /ErrorInternalServerTransientError|Cannot query rows|timeout/i.test(errText);
          if (transient && attempt < maxAttempts - 1) {
            await new Promise(r => setTimeout(r, is429 ? wait429ms : 800 * (attempt + 1)));
            continue;
          }
          throw new Error(`Outlook fetchMessages failed: ${response.status} ${errText}`);
        }
        const data = JSON.parse(errText);
        const rows = Array.isArray(data.value) ? data.value : [];
        return rows.map((msg: Record<string, any>) => mapMessage(msg));
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        const msg = lastErr.message;
        const transient =
          /503|502|504|ErrorInternalServerTransientError|Cannot query rows|ETIMEDOUT|network/i.test(msg);
        if (transient && attempt < maxAttempts - 1) {
          await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        throw lastErr;
      }
    }
    throw lastErr || new Error('Outlook fetchMessages failed');
  }

  /** Max messages to pull across all pages for one search (safety cap). */
  private static readonly SEARCH_MAX_TOTAL = 10000;
  /** Page size for each Graph request (search supports pagination via @odata.nextLink). */
  private static readonly SEARCH_PAGE_SIZE = 100;

  /**
   * Search messages across folders. Follows @odata.nextLink until exhausted or maxResults.
   * @param account Account object with token auth.
   * @param query Search query (keywords).
   * @param folderId Optional folder ID to restrict search.
   * @param pageSize Results per HTTP request (default 100).
   * @param maxResults Hard cap across all pages (default 10000).
   */
  static async searchMessages(
    account: UIAccount,
    query: string,
    folderId?: string,
    pageSize: number = OutlookService.SEARCH_PAGE_SIZE,
    maxResults: number = OutlookService.SEARCH_MAX_TOTAL
  ): Promise<OutlookSearchResult[]> {
    const safe = String(query).replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
    const top = Math.min(Math.max(pageSize, 1), 999);
    const cap = Math.min(Math.max(maxResults, 1), OutlookService.SEARCH_MAX_TOTAL);

    let path = `${this.baseUrl}/me/messages`;
    const params = new URLSearchParams();
    params.append('$search', `"${safe}"`);
    params.append('$top', String(top));
    // Use ParentFolderId — 'FolderId' is not valid on Message in Outlook REST v2 (400).
    params.append('$select', 'Id,Subject,BodyPreview,WebLink,ReceivedDateTime,From,ParentFolderId');

    if (folderId) {
      const folderPath = mailFolderPathSegment(folderId);
      path = `${this.baseUrl}/me/${folderPath}/messages`;
    }

    let url: string | null = `${path}?${params.toString()}`;
    const collected: OutlookSearchResult[] = [];

    while (url && collected.length < cap) {
      let response!: Response;
      for (let attempt = 0; attempt < 5; attempt++) {
        const token = await this.getAccessToken(account);
        response = await fetch(url!, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });
        if (response.status === 429 && attempt < 4) {
          const ra = parseInt(response.headers.get('Retry-After') || '3', 10);
          await new Promise(r =>
            setTimeout(r, Math.min((Number.isFinite(ra) ? ra : 3) * 1000, 120000))
          );
          continue;
        }
        break;
      }

      const errText = await response.text();
      if (!response.ok) {
        throw new Error(`Outlook searchMessages failed: ${response.status} ${errText}`);
      }
      let data: Record<string, any>;
      try {
        data = JSON.parse(errText);
      } catch {
        throw new Error('Outlook searchMessages: invalid JSON');
      }
      const rows = Array.isArray(data.value) ? data.value : [];
      for (const row of rows) {
        if (collected.length >= cap) break;
        collected.push(mapMessage(row as Record<string, any>) as OutlookSearchResult);
      }
      const nextLink =
        (data['@odata.nextLink'] as string | undefined) ||
        (data['odata.nextLink'] as string | undefined);
      url = nextLink && collected.length < cap ? nextLink : null;
      if (url && collected.length < cap) {
        await new Promise(r => setTimeout(r, 40));
      }
    }

    if (collected.length >= cap) {
      console.warn(
        `[Outlook] searchMessages stopped at ${cap} results (cap). Narrow keywords, folder, or date range for a smaller set.`
      );
    }
    return collected;
  }

  /**
   * Get message details (full body).
   */
  static async getMessageDetails(
    account: UIAccount,
    messageId: string
  ): Promise<{ body: { content: string; contentType: string } }> {
    const token = await this.getAccessToken(account);
    // Immutable IDs often contain +, /, = — do not use encodeURIComponent in path (ErrorInvalidIdMalformed).
    const escaped = messageId.replace(/'/g, "''");
    const response = await fetch(`${this.baseUrl}/me/Messages('${escaped}')`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Outlook getMessageDetails failed: ${response.status} ${await response.text()}`);
    }
    const data = await response.json();
    const body = data.Body ?? data.body;
    return {
      body: {
        content: body?.Content ?? body?.content ?? '',
        contentType: body?.ContentType ?? body?.contentType ?? 'html',
      },
    };
  }

  private static escapeMessageId(messageId: string): string {
    return messageId.replace(/'/g, "''");
  }

  /** Resolve well-known folder (e.g. JunkEmail, DeletedItems) to its opaque id for move operations. */
  static async getWellKnownFolderId(account: UIAccount, wellKnown: 'JunkEmail' | 'DeletedItems'): Promise<string> {
    const token = await this.getAccessToken(account);
    const response = await fetch(`${this.baseUrl}/me/MailFolders('${wellKnown}')`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    const errText = await response.text();
    if (!response.ok) {
      throw new Error(`Outlook getWellKnownFolderId(${wellKnown}) failed: ${response.status} ${errText}`);
    }
    const data = JSON.parse(errText);
    const id = data.Id ?? data.id;
    if (!id) throw new Error(`Outlook: no folder id for ${wellKnown}`);
    return id;
  }

  /** POST /move — moves message to another folder (e.g. Junk). */
  static async moveMessage(account: UIAccount, messageId: string, destinationFolderId: string): Promise<void> {
    const token = await this.getAccessToken(account);
    const id = this.escapeMessageId(messageId);
    const response = await fetch(`${this.baseUrl}/me/Messages('${id}')/move`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ DestinationId: destinationFolderId }),
    });
    if (!response.ok) {
      throw new Error(`Outlook moveMessage failed: ${response.status} ${await response.text()}`);
    }
  }

  /** Soft-delete (recoverable). */
  static async deleteMessage(account: UIAccount, messageId: string): Promise<void> {
    const token = await this.getAccessToken(account);
    const id = this.escapeMessageId(messageId);
    const response = await fetch(`${this.baseUrl}/me/Messages('${id}')`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Outlook deleteMessage failed: ${response.status} ${await response.text()}`);
    }
  }

  static async setMessageReadState(account: UIAccount, messageId: string, isRead: boolean): Promise<void> {
    const token = await this.getAccessToken(account);
    const id = this.escapeMessageId(messageId);
    const response = await fetch(`${this.baseUrl}/me/Messages('${id}')`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ IsRead: isRead }),
    });
    if (!response.ok) {
      throw new Error(`Outlook setMessageReadState failed: ${response.status} ${await response.text()}`);
    }
  }

  /**
   * Send a reply to a message (plain-text Comment body; HTML in template is stripped).
   * POST .../Messages('{id}')/reply
   */
  static async replyToMessage(account: UIAccount, messageId: string, commentPlainText: string): Promise<void> {
    const token = await this.getAccessToken(account);
    const id = this.escapeMessageId(messageId);
    const response = await fetch(`${this.baseUrl}/me/Messages('${id}')/reply`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ Comment: commentPlainText }),
    });
    if (!response.ok) {
      throw new Error(`Outlook replyToMessage failed: ${response.status} ${await response.text()}`);
    }
  }

  /** Compose and send a new message (Outlook REST v2.0; same token as folder reads). */
  static async sendNewMessage(
    account: UIAccount,
    params: {
      subject: string;
      body: string;
      bodyIsHtml: boolean;
      toRecipients: string[];
      ccRecipients?: string[];
      bccRecipients?: string[];
      attachments?: {
        name: string;
        contentType: string;
        contentBytesBase64: string;
        /** True for inline images referenced via `cid:<contentId>` in the HTML body. */
        isInline?: boolean;
        /** Required when `isInline` is true; the cid referenced in the body. */
        contentId?: string;
      }[];
      saveToSentItems?: boolean;
    }
  ): Promise<void> {
    const token = await this.getAccessToken(account);
    const mapAddr = (address: string) => ({
      EmailAddress: { Address: address.trim() },
    });
    const message: Record<string, unknown> = {
      Subject: params.subject,
      Body: {
        ContentType: params.bodyIsHtml ? 'HTML' : 'Text',
        Content: params.body,
      },
      ToRecipients: params.toRecipients.filter(Boolean).map(mapAddr),
    };
    if (params.ccRecipients?.length) {
      message.CcRecipients = params.ccRecipients.filter(Boolean).map(mapAddr);
    }
    if (params.bccRecipients?.length) {
      message.BccRecipients = params.bccRecipients.filter(Boolean).map(mapAddr);
    }
    if (params.attachments?.length) {
      message.Attachments = params.attachments.map(a => {
        const att: Record<string, unknown> = {
          '@odata.type': '#Microsoft.OutlookServices.FileAttachment',
          Name: a.name,
          ContentType: a.contentType || 'application/octet-stream',
          ContentBytes: a.contentBytesBase64,
        };
        if (a.isInline) {
          att.IsInline = true;
          if (a.contentId) att.ContentId = a.contentId;
        }
        return att;
      });
    }
    const response = await fetch(`${this.baseUrl}/me/sendmail`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Message: message,
        SaveToSentItems: params.saveToSentItems !== false,
      }),
    });
    if (!response.ok) {
      throw new Error(`Outlook sendNewMessage failed: ${response.status} ${await response.text()}`);
    }
  }
}

/**
 * Cached mock-mode flag. Updated synchronously by `setOutlookMockMode` so the
 * factory below can answer without awaiting a fresh settings read on every
 * call. `initOutlookServiceFromSettings()` should be invoked once at app
 * startup (App.tsx) and again whenever Settings → Debug is saved.
 *
 * Default `false` keeps the production behaviour (real OutlookService) if
 * initialisation fails or has not run yet.
 */
let __useMockOutlook = false;

export function setOutlookMockMode(useMock: boolean): void {
  __useMockOutlook = !!useMock;
}

/**
 * Read the persisted Settings once and update the cached mock-mode flag.
 * Honours both the new `useMockOutlookApi` field and the legacy
 * `useMockGraphApi` field for back-compat with older stored settings.
 */
export async function initOutlookServiceFromSettings(): Promise<void> {
  try {
    const settings = await getSettings();
    const flag =
      settings.debug?.useMockOutlookApi ??
      settings.debug?.useMockGraphApi ??
      false;
    setOutlookMockMode(!!flag);
  } catch (err) {
    // Never let a settings read failure crash startup; default to real service.
    console.warn('[OutlookService] init from settings failed; using real service:', err);
    setOutlookMockMode(false);
  }
}

/**
 * Factory to pick real or mock service. Synchronous so existing call-sites
 * (`getOutlookService().fetchMessages(...)`) keep working without changes.
 */
export function getOutlookService() {
  return __useMockOutlook ? MockOutlookService : OutlookService;
}

/**
 * Mock Outlook service for debugging.
 */
class MockOutlookService {
  static async listFolders(_account: UIAccount): Promise<OutlookFolder[]> {
    return [
      { id: 'inbox', displayName: 'Inbox', totalItemCount: 42, unreadItemCount: 3 },
      { id: 'sentitems', displayName: 'Sent Items', totalItemCount: 120, unreadItemCount: 0 },
      { id: 'drafts', displayName: 'Drafts', totalItemCount: 5, unreadItemCount: 0 },
    ];
  }

  static async listAllFoldersRecursive(_account: UIAccount): Promise<OutlookFolder[]> {
    return MockOutlookService.listFolders(_account);
  }

  static async fetchMessagesForContactExtraction(
    account: UIAccount,
    opts?: { perFolder?: number; maxMessages?: number }
  ): Promise<OutlookMessage[]> {
    const perFolder = opts?.perFolder ?? 50;
    const maxMessages = opts?.maxMessages ?? 200;
    const folders = await MockOutlookService.listFolders(account);
    const out: OutlookMessage[] = [];
    for (const f of folders) {
      const batch = await MockOutlookService.fetchMessages(account, f.id, undefined, perFolder);
      out.push(...batch);
      if (out.length >= maxMessages) break;
    }
    return out.slice(0, maxMessages);
  }

  static async fetchMessages(
    _account: UIAccount,
    folderId: string = 'inbox',
    _since?: string,
    limit: number = 50
  ): Promise<OutlookMessage[]> {
    const messages: OutlookMessage[] = [];
    for (let i = 0; i < limit; i++) {
      messages.push({
        id: `mock-${folderId}-${i}`,
        subject: `Test message ${i}`,
        bodyPreview: `This is a mock message body preview for debugging.`,
        webLink: `https://outlook.office.com/mock`,
        receivedDateTime: new Date(Date.now() - i * 60000).toISOString(),
        conversationId: `mock-conv-${i % 5}`,
        from: { emailAddress: { address: 'sender@example.com', name: 'Sender' } },
        toRecipients: [
          { emailAddress: { address: `to-${i}@example.org`, name: `Recipient ${i}` } },
          { emailAddress: { address: 'shared@contoso.com' } },
        ],
        ccRecipients:
          i % 2 === 0 ? [{ emailAddress: { address: 'cc@partner.com', name: 'CC User' } }] : [],
        bccRecipients: [],
        folderId,
      });
    }
    return messages;
  }

  static async fetchAllMessagesInFolderPaginated(
    account: UIAccount,
    folderId: string,
    opts?: { maxPerFolder?: number; pageSize?: number }
  ): Promise<OutlookMessage[]> {
    const limit = Math.min(opts?.maxPerFolder ?? 100, 10000);
    return MockOutlookService.fetchMessages(account, folderId, undefined, limit);
  }

  static async searchMessages(
    _account: UIAccount,
    query: string,
    _folderId?: string,
    pageSize: number = 100,
    maxResults: number = 10000
  ): Promise<OutlookSearchResult[]> {
    const n = Math.min(Math.max(pageSize, 1), maxResults);
    const results: OutlookSearchResult[] = [];
    for (let i = 0; i < n; i++) {
      results.push({
        id: `search-${i}`,
        subject: `Result ${i} for "${query}"`,
        bodyPreview: `Mock search result snippet containing "${query}".`,
        webLink: `https://outlook.office.com/mock`,
        receivedDateTime: new Date(Date.now() - i * 60000).toISOString(),
        from: { emailAddress: { address: 'sender@example.com' } },
        folderId: 'inbox',
      });
    }
    return results;
  }

  static async getMessageDetails(
    _account: UIAccount,
    messageId: string
  ): Promise<{ body: { content: string; contentType: string } }> {
    return {
      body: {
        content: `<html><body><p>Mock message body for ${messageId}. This is used for debugging.</p></body></html>`,
        contentType: 'html',
      },
    };
  }

  static async getWellKnownFolderId(_account: UIAccount, wellKnown: 'JunkEmail' | 'DeletedItems'): Promise<string> {
    return `mock-folder-${wellKnown}`;
  }

  static async moveMessage(_account: UIAccount, _messageId: string, _destinationFolderId: string): Promise<void> {
    /* no-op mock */
  }

  static async deleteMessage(_account: UIAccount, _messageId: string): Promise<void> {
    /* no-op mock */
  }

  static async setMessageReadState(_account: UIAccount, _messageId: string, _isRead: boolean): Promise<void> {
    /* no-op mock */
  }

  static async replyToMessage(_account: UIAccount, _messageId: string, _commentPlainText: string): Promise<void> {
    /* no-op mock */
  }

  static async sendNewMessage(_account: UIAccount, _params: Parameters<typeof OutlookService.sendNewMessage>[1]): Promise<void> {
    /* no-op mock */
  }
}