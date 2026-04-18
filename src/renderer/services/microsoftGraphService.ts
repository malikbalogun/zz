import type { UIAccount } from '../../types/store';
import { refreshMicrosoftToken } from './microsoftTokenService';

export interface GraphMessage {
  id: string;
  subject?: string;
  bodyPreview?: string;
  webLink?: string;
  receivedDateTime: string;
  from?: { emailAddress: { address?: string } };
  folderId?: string;
}

export interface GraphFolder {
  id: string;
  displayName: string;
  totalItemCount: number;
  unreadItemCount: number;
}

export interface GraphSearchResult {
  id: string;
  subject?: string;
  bodyPreview?: string;
  webLink?: string;
  receivedDateTime: string;
  from?: { emailAddress: { address?: string } };
  folderId?: string;
}

/**
 * Microsoft Graph API service.
 * Uses locally stored tokens (via refresh) to call Graph endpoints.
 */
export class MicrosoftGraphService {
  private static baseUrl = 'https://graph.microsoft.com/v1.0';

  /**
   * Get a fresh access token for an account.
   * Refreshes if necessary.
   */
  static async getAccessToken(account: UIAccount): Promise<string> {
    console.log('[Microsoft] getAccessToken called for', account.email);
    if (account.auth?.type !== 'token') {
      throw new Error(`Account ${account.email} does not have token auth`);
    }
    const { clientId, authorityEndpoint, refreshToken } = account.auth;
    if (!clientId || !authorityEndpoint || !refreshToken) {
      throw new Error(`Missing auth fields for ${account.email}`);
    }
    // We could cache the token, but for simplicity we refresh each time.
    // The token refresh function already handles expiration and returns fresh access token.
    console.log('[Microsoft] Calling refreshMicrosoftToken via IPC');
    const result = await refreshMicrosoftToken(clientId, authorityEndpoint, refreshToken, 'graph');
    console.log('[Microsoft] Got access token, expires in', result.expiresIn);
    return result.accessToken;
  }

  /**
   * List all mailbox folders for an account.
   */
  static async listFolders(account: UIAccount): Promise<GraphFolder[]> {
    const token = await this.getAccessToken(account);
    const response = await fetch(`${this.baseUrl}/me/mailFolders`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Graph listFolders failed: ${response.status} ${await response.text()}`);
    }
    const data = await response.json();
    return data.value.map((f: any) => ({
      id: f.id,
      displayName: f.displayName,
      totalItemCount: f.totalItemCount,
      unreadItemCount: f.unreadItemCount,
    }));
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
  ): Promise<GraphMessage[]> {
    const token = await this.getAccessToken(account);
    let url = `${this.baseUrl}/me/mailFolders/${folderId}/messages`;
    const params = new URLSearchParams();
    params.append('$top', limit.toString());
    params.append('$orderby', 'receivedDateTime desc');
    params.append('$select', 'id,subject,bodyPreview,webLink,receivedDateTime,from,folderId');
    if (since) {
      params.append('$filter', `receivedDateTime ge ${since}`);
    }
    url += `?${params.toString()}`;
    
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Graph fetchMessages failed: ${response.status} ${await response.text()}`);
    }
    const data = await response.json();
    return data.value.map((msg: any) => ({
      id: msg.id,
      subject: msg.subject,
      bodyPreview: msg.bodyPreview,
      webLink: msg.webLink,
      receivedDateTime: msg.receivedDateTime,
      from: msg.from,
      folderId: msg.folderId,
    }));
  }

  /**
   * Search messages across entire mailbox (or within a folder).
   * @param account Account object with token auth.
   * @param query Search query (plain text, Graph search syntax).
   * @param folderId Optional folder ID to restrict search.
   * @param limit Max results (default 100).
   */
  static async searchMessages(
    account: UIAccount,
    query: string,
    folderId?: string,
    limit: number = 100
  ): Promise<GraphSearchResult[]> {
    const token = await this.getAccessToken(account);
    let url = folderId
      ? `${this.baseUrl}/me/mailFolders/${folderId}/messages`
      : `${this.baseUrl}/me/messages`;
    const params = new URLSearchParams();
    params.append('$top', limit.toString());
    params.append('$search', `"${query}"`);
    params.append('$select', 'id,subject,bodyPreview,webLink,receivedDateTime,from,folderId');
    url += `?${params.toString()}`;
    
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Graph searchMessages failed: ${response.status} ${await response.text()}`);
    }
    const data = await response.json();
    return data.value.map((msg: any) => ({
      id: msg.id,
      subject: msg.subject,
      bodyPreview: msg.bodyPreview,
      webLink: msg.webLink,
      receivedDateTime: msg.receivedDateTime,
      from: msg.from,
      folderId: msg.folderId,
    }));
  }

  /**
   * Get full message details including body.
   */
  static async getMessageDetails(
    account: UIAccount,
    messageId: string
  ): Promise<{ body: { content: string; contentType: string } }> {
    const token = await this.getAccessToken(account);
    const response = await fetch(`${this.baseUrl}/me/messages/${messageId}?$select=body`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Graph getMessageDetails failed: ${response.status} ${await response.text()}`);
    }
    const data = await response.json();
    return { body: data.body };
  }
}

/**
 * Mock implementation for debugging when real tokens are unavailable.
 */
export class MockMicrosoftGraphService {
  static async listFolders(_account: UIAccount): Promise<GraphFolder[]> {
    return [
      { id: 'inbox', displayName: 'Inbox', totalItemCount: 42, unreadItemCount: 3 },
      { id: 'sentitems', displayName: 'Sent Items', totalItemCount: 120, unreadItemCount: 0 },
      { id: 'drafts', displayName: 'Drafts', totalItemCount: 5, unreadItemCount: 0 },
    ];
  }

  static async fetchMessages(
    _account: UIAccount,
    folderId: string = 'inbox',
    _since?: string,
    limit: number = 50
  ): Promise<GraphMessage[]> {
    const messages: GraphMessage[] = [];
    for (let i = 0; i < limit; i++) {
      messages.push({
        id: `mock-${folderId}-${i}`,
        subject: `Test message ${i}`,
        bodyPreview: `This is a mock message body preview for debugging.`,
        webLink: `https://outlook.office365.com/mock`,
        receivedDateTime: new Date(Date.now() - i * 60000).toISOString(),
        from: { emailAddress: { address: 'sender@example.com' } },
        folderId,
      });
    }
    return messages;
  }

  static async searchMessages(
    _account: UIAccount,
    query: string,
    _folderId?: string,
    limit: number = 100
  ): Promise<GraphSearchResult[]> {
    const results: GraphSearchResult[] = [];
    for (let i = 0; i < limit; i++) {
      results.push({
        id: `search-${i}`,
        subject: `Result ${i} for "${query}"`,
        bodyPreview: `Mock search result snippet containing "${query}".`,
        webLink: `https://outlook.office365.com/mock`,
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
}

/**
 * Factory to pick real or mock service based on settings.
 */
export function getGraphService() {
  // @ts-ignore – will be replaced with real settings check
  const useMock = window.electron?.store?.get('settings')?.debug?.useMockGraphApi ?? false;
  return useMock ? MockMicrosoftGraphService : MicrosoftGraphService;
}