import { UIAccount } from '../../types/store';
import { OutlookService } from './outlookService';

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

  // The Outlook REST surface used elsewhere in this app does not expose a
  // contacts endpoint under the EWS-scope token we hold. Contacts get
  // *synthesised* from message senders/recipients in `contactService.ts`,
  // which is what every UI flow actually relies on. Throw a clear error so
  // any future caller that expects a real contacts API gets a real signal.
  static async getContacts(_account: UIAccount, _limit: number = 500): Promise<any[]> {
    throw new Error(
      'MailService.getContacts: no contacts endpoint with the EWS-scope token in use. ' +
      'Use contactService to derive contacts from message metadata instead.'
    );
  }

  // Admin user listing (Graph /users) requires admin scopes that this
  // app does not currently request. Left as a clear error rather than a
  // silent stub so the UI can surface a proper "not configured" message.
  static async listUsers(_account: UIAccount): Promise<any[]> {
    throw new Error(
      'MailService.listUsers: admin user enumeration requires Graph admin scopes that are not currently requested.'
    );
  }
}