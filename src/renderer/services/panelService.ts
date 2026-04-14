/**
 * Barrel re-export for panel services.
 *
 * The implementation is split across three focused modules:
 *   - panelStore  — CRUD, encryption, persistence
 *   - panelAuth   — connection testing & authentication
 *   - panelApi    — remote panel REST endpoints (accounts, tokens, emails)
 *
 * All public symbols are re-exported here so existing callers don't break.
 */

export {
  encryptPassword,
  decryptPassword,
  getPanels,
  getPanel,
  savePanels,
  addPanel,
  updatePanel,
  deletePanel,
} from './panelStore';

export {
  testPanelConnection,
  authenticatePanel,
} from './panelAuth';

export {
  fetchAccounts,
  exportToken,
  exportMailboxCookies,
  fetchFolders,
  fetchEmails,
  searchEmails,
  exportTokensBatch,
} from './panelApi';

export type { PanelExportCookiesResult } from './panelApi';
