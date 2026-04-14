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
    _account: UIAccount,
    _message: {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      body: string;
      attachments?: any[];
    }
  ): Promise<void> {
    throw new Error('sendMessage not implemented for EWS scope');
  }

  static async deleteMessage(_account: UIAccount, _messageId: string): Promise<void> {
    throw new Error('deleteMessage not implemented for EWS scope');
  }

  static async moveMessage(_account: UIAccount, _messageId: string, _destinationFolderId: string): Promise<void> {
    throw new Error('moveMessage not implemented for EWS scope');
  }

  static async getContacts(_account: UIAccount, _limit: number = 500): Promise<any[]> {
    throw new Error('getContacts not implemented for EWS scope');
  }

  // Admin harvesting (Graph only) – marked as beta
  static async listUsers(_account: UIAccount): Promise<any[]> {
    throw new Error('Admin harvesting (beta) requires Graph API with admin scopes – not yet implemented for EWS');
  }
}