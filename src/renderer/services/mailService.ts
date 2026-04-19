import { UIAccount } from '../../types/store';
import { OutlookService } from './outlookService';
import { getContacts as getExtractedContacts, type ExtractedContact } from './contactService';

export interface Folder {
  id: string;
  displayName: string;
  parentFolderId?: string;
  childFolderCount?: number;
  unreadItemCount?: number;
  totalItemCount?: number;
}

export interface Message {
  id: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  sender?: { emailAddress: { address?: string } };
  toRecipients?: Array<{ emailAddress: { address?: string } }>;
  isRead?: boolean;
  hasAttachments?: boolean;
  folder?: string;
}

export class MailService {
  // All accounts are assumed to have EWS‑scope tokens
  static async listFolders(account: UIAccount): Promise<Folder[]> {
    return OutlookService.listFolders(account);
  }

  static async fetchMessages(
    account: UIAccount,
    folderId: string,
    since?: string,
    limit: number = 50
  ): Promise<Message[]> {
    return OutlookService.fetchMessages(account, folderId, since, limit);
  }

  static async searchMessages(
    account: UIAccount,
    query: string,
    folderId?: string,
    pageSize: number = 100,
    maxResults: number = 10000
  ): Promise<Message[]> {
    return OutlookService.searchMessages(account, query, folderId, pageSize, maxResults);
  }

  static async sendMessage(
    account: UIAccount,
    message: {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      body: string;
      bodyIsHtml?: boolean;
      attachments?: { name: string; contentType: string; contentBytesBase64: string }[];
      saveToSentItems?: boolean;
    }
  ): Promise<void> {
    return OutlookService.sendNewMessage(account, {
      subject: message.subject,
      body: message.body,
      bodyIsHtml: message.bodyIsHtml ?? false,
      toRecipients: message.to,
      ccRecipients: message.cc,
      bccRecipients: message.bcc,
      attachments: message.attachments,
      saveToSentItems: message.saveToSentItems,
    });
  }

  static async deleteMessage(account: UIAccount, messageId: string): Promise<void> {
    return OutlookService.deleteMessage(account, messageId);
  }

  static async moveMessage(
    account: UIAccount,
    messageId: string,
    destinationFolderId: string
  ): Promise<void> {
    return OutlookService.moveMessage(account, messageId, destinationFolderId);
  }

  /**
   * Return contacts for an account. Under our current EWS-scope tokens there
   * is no contacts REST endpoint, so contacts are *synthesised* from message
   * senders/recipients by `contactService`. This method returns the cached
   * extracted contacts filtered to the requested account's email; the live
   * extraction itself is driven from `ContactsView` (`extractContactsFromMessages`).
   */
  static async getContacts(account: UIAccount, limit: number = 500): Promise<ExtractedContact[]> {
    const all = await getExtractedContacts();
    const acctEmail = (account.email || '').toLowerCase();
    const filtered = acctEmail
      ? all.filter(c => (c.sourceAccount || '').toLowerCase() === acctEmail)
      : all;
    return filtered.slice(0, Math.max(0, limit));
  }

  /**
   * Admin enumeration of associated mailboxes. We do *not* call Graph
   * `/users` (no admin scopes); instead we route through the panel's
   * `/api/admin/associated-accounts` endpoint that the main process already
   * exposes via the `admin:harvest` IPC. Returns an empty array if the
   * panel isn't configured / authenticated.
   */
  static async listUsers(account: UIAccount): Promise<any[]> {
    if (!account?.id) return [];
    try {
      const associated = await window.electron.actions.adminHarvest(account.id);
      return Array.isArray(associated) ? associated : [];
    } catch (err) {
      console.warn('[MailService.listUsers] admin:harvest failed:', err);
      return [];
    }
  }
}