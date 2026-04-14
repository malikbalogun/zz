import { useState, useEffect, type FC } from 'react';
import {
  refreshAccountToken,
  openOutlookWeb,
  openPanelMailbox,
  openPanelAdminDashboard,
  harvestAssociatedAccounts,
  openOwaExternalBrowserSession,
  pullOwaCookiesFromPanel,
  setOwaMailboxMode,
} from '../../services/accountSyncService';
import { getAccounts, deleteAccount } from '../../services/accountService';
import { getSystemTags, getUserTags } from '../../services/tagService';
import { Tag } from '../../../types/store';
import { Panel } from '../../../types/panel';
import { getPanels } from '../../services/panelService';
import AddAccountModal, { type AddAccountInitialTab } from '../AddAccountModal';
import DeleteConfirmModalComponent from '../DeleteConfirmModal';
import TagEditorModalComponent from '../TagEditorModal';
import ExportModalComponent from '../ExportModal';

interface AccountsViewProps {
  /** When set (e.g. from Dashboard), open Add Account on this tab once, then call onOpenAddAccountConsumed. */
  openAddAccountWithTab?: AddAccountInitialTab | null;
  onOpenAddAccountConsumed?: () => void;
}

const AccountsView: FC<AccountsViewProps> = ({
  openAddAccountWithTab = null,
  onOpenAddAccountConsumed,
}) => {
  // Data
  const [accounts, setAccounts] = useState<any[]>([]);
  const [panels, setPanels] = useState<Panel[]>([]);
  const [systemTags, setSystemTags] = useState<Tag[]>([]);
  const [userTags, setUserTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(false);

  // UI state
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addModalInitialTab, setAddModalInitialTab] = useState<AddAccountInitialTab | undefined>(undefined);
  const [showEditTagsModal, setShowEditTagsModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [activeAccount, setActiveAccount] = useState<string | null>(null); // for single‑account actions
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'expired'>('all');

  // Load data on mount
  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!openAddAccountWithTab) return;
    setAddModalInitialTab(openAddAccountWithTab);
    setShowAddModal(true);
    const t = window.setTimeout(() => {
      onOpenAddAccountConsumed?.();
    }, 0);
    return () => window.clearTimeout(t);
  }, [openAddAccountWithTab, onOpenAddAccountConsumed]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.act-menu-wrap')) {
        setOpenDropdownId(null);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [accs, sys, usr, panelList] = await Promise.all([
        getAccounts(),
        getSystemTags(),
        getUserTags(),
        getPanels(),
      ]);
      setAccounts(accs);
      setSystemTags(sys);
      setUserTags(usr);
      setPanels(panelList);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  };

  // Helper: get tag object by id
  // Generate a consistent color for a tag id
  const generateTagColorFromId = (id: string): string => {
    const colors = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ef4444', '#06b6d4', '#8b5cf6', '#84cc16', '#f97316', '#6366f1'];
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = ((hash << 5) - hash) + id.charCodeAt(i);
      hash |= 0;
    }
    const index = Math.abs(hash) % colors.length;
    return colors[index];
  };

  const getTagById = (id: string): Tag | undefined => {
    // Check if it's a panel tag
    if (id.startsWith('panel-')) {
      const panelId = id.slice(6); // remove 'panel-' prefix
      const panel = panels.find(p => p.id === panelId);
      return {
        id,
        name: panel ? panel.name : `Panel ${panelId}`,
        color: generateTagColorFromId(panelId),
        icon: 'fa-server',
        type: 'system' as const,
        locked: true,
      };
    }
    return [...systemTags, ...userTags].find(t => t.id === id);
  };

  // Individual token refresh
  const handleRefreshToken = async (accountId: string) => {
    setLoading(true);
    try {
      await refreshAccountToken(accountId);
      alert(`Token refreshed for account ${accountId}`);
      await loadData(); // refresh list
    } catch (error) {
      alert(`Failed to refresh token: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  // OWA (outlook.office.com) with token injection — play button and “Open Outlook (Web)”
  const handleOpenOutlookWeb = async (accountId: string) => {
    setLoading(true);
    try {
      await openOutlookWeb(accountId);
    } catch (error) {
      alert(`Failed to open Outlook (OWA): ${error instanceof Error ? error.message : error}`);
    } finally {
      setLoading(false);
    }
  };

  const handleOwaExternalBrowserOAuth = async (accountId: string) => {
    setLoading(true);
    try {
      await openOwaExternalBrowserSession(accountId);
    } catch (error) {
      alert(`Failed to open Microsoft sign-in: ${error instanceof Error ? error.message : error}`);
    } finally {
      setLoading(false);
    }
  };

  const handlePullOwaCookiesFromPanel = async (accountId: string) => {
    setLoading(true);
    try {
      await pullOwaCookiesFromPanel(accountId);
      alert('OWA session cookies saved on this account. Set OWA mode to “Cookies” if you want in-app Outlook to use them.');
      await loadData();
    } catch (error) {
      alert(`Pull cookies from panel failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSetOwaMode = async (accountId: string, mode: 'token' | 'cookie') => {
    setLoading(true);
    try {
      await setOwaMailboxMode(accountId, mode);
      await loadData();
    } catch (error) {
      alert(`Could not update OWA mode: ${error instanceof Error ? error.message : error}`);
    } finally {
      setLoading(false);
    }
  };

  // Panel admin mailbox page (separate from OWA)
  const handleOpenPanelMailbox = async (accountId: string) => {
    setLoading(true);
    try {
      await openPanelMailbox(accountId);
    } catch (error) {
      alert(`Failed to open panel mailbox: ${error instanceof Error ? error.message : error}`);
    } finally {
      setLoading(false);
    }
  };

  // Individual admin harvest
  const handleAdminHarvest = async (accountId: string) => {
    setLoading(true);
    try {
      const associated = await harvestAssociatedAccounts(accountId);
      alert(`Harvested ${associated.length} associated accounts`);
    } catch (error) {
      alert(`Harvest failed: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  // Bulk token refresh
  const handleBulkRefresh = async () => {
    if (selectedAccounts.length === 0) {
      alert('No accounts selected');
      return;
    }
    setLoading(true);
    try {
      for (const accountId of selectedAccounts) {
        await refreshAccountToken(accountId);
      }
      alert(`Refreshed tokens for ${selectedAccounts.length} accounts`);
      setSelectedAccounts([]);
      await loadData();
    } catch (error) {
      alert(`Bulk refresh failed: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  // Bulk export (placeholder – will call IPC)
  const handleBulkExport = () => {
    setShowExportModal(true);
  };

  // Bulk edit tags
  const handleBulkEditTags = () => {
    if (selectedAccounts.length === 0) {
      alert('No accounts selected');
      return;
    }
    setShowEditTagsModal(true);
  };

  // Bulk delete
  const handleBulkDelete = () => {
    if (selectedAccounts.length === 0) {
      alert('No accounts selected');
      return;
    }
    setShowDeleteConfirm(true);
  };

  // Individual edit tags
  const handleEditTags = (accountId: string) => {
    setActiveAccount(accountId);
    setShowEditTagsModal(true);
  };

  // Individual export account
  const handleExportAccount = (accountId: string) => {
    setActiveAccount(accountId);
    setShowExportModal(true);
  };

  // Individual delete account
  const handleDeleteAccount = async (accountId: string) => {
    if (!confirm('Delete this account? This cannot be undone.')) return;
    setLoading(true);
    try {
      await deleteAccount(accountId);
      alert('Account deleted');
      await loadData();
      // Notify App to update sidebar badge
      window.dispatchEvent(new CustomEvent('accounts-changed'));
    } catch (error) {
      alert(`Delete failed: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  // Toggle account selection
  const toggleAccountSelection = (accountId: string) => {
    setSelectedAccounts(prev =>
      prev.includes(accountId)
        ? prev.filter(id => id !== accountId)
        : [...prev, accountId]
    );
  };

  // Select all accounts
  const handleSelectAll = () => {
    const allIds = accounts.map(a => a.id);
    setSelectedAccounts(prev =>
      prev.length === allIds.length ? [] : allIds
    );
  };

  // Add account
  const handleAddAccount = () => {
    setAddModalInitialTab(undefined);
    setShowAddModal(true);
  };

  const handleOpenSessionBridgeModal = () => {
    setAddModalInitialTab('bridge');
    setShowAddModal(true);
  };

  // Manage tags (navigate to Settings)
  const handleManageTags = () => {
    // In a real app you would switch to Settings view
    alert('Navigate to Settings → Tag Management');
  };

  const handleCopyOutlookDebugLogs = async () => {
    try {
      const result = await window.electron.actions.copyOutlookDebugLogs();
      if (result?.success) {
        alert(`Copied ${result.lines} Outlook debug lines to clipboard.\nSaved to: ${result.path}`);
      } else {
        alert('Failed to copy Outlook debug logs');
      }
    } catch (error) {
      alert(`Failed to copy Outlook debug logs: ${error instanceof Error ? error.message : error}`);
    }
  };



  // Export modal




  // Helper: render tag pill
  const renderTag = (tagId: string) => {
    const tag = getTagById(tagId);
    if (!tag) return null;
    const isSystem = tag.type === 'system';
    return (
      <span
        className={`stag ${isSystem ? 'stag-' + tag.id : 'tag'}`}
        style={{ borderLeftColor: tag.color }}
        title={tag.name}
      >
        {isSystem && <i className="fas fa-lock stag-lock"></i>}
        {tag.name}
      </span>
    );
  };

  // Compute stats
  const totalAccounts = accounts.length;
  const activeAccounts = accounts.filter(a => a.status === 'active').length;
  const expiredAccounts = accounts.filter(a => a.status === 'expired').length;

  // Tag counts (simple)
  const tagCounts: Record<string, number> = {};
  accounts.forEach(acc => {
    acc.tags.forEach((tagId: string) => {
      tagCounts[tagId] = (tagCounts[tagId] || 0) + 1;
    });
  });

  // Filter accounts by selected tag (if any)
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const filteredAccounts = accounts.filter(acc => {
    if (activeTag && !acc.tags.includes(activeTag)) return false;
    if (statusFilter === 'active' && acc.status !== 'active') return false;
    if (statusFilter === 'expired' && acc.status !== 'expired') return false;
    return true;
  });

  // If loading, show spinner
  if (loading && accounts.length === 0) {
    return <div className="accounts-container">Loading accounts...</div>;
  }

  return (
    <div id="accountsView">
      <div className="accounts-container">
        {/* Left sidebar */}
        <div className="folders-sidebar">
          <div
            className={`folder-item ${activeTag === null ? 'active' : ''}`}
            data-tag="all"
            style={{ marginBottom: '12px', paddingBottom: '12px', borderBottom: '2px solid #e5e7eb' }}
            onClick={() => setActiveTag(null)}
          >
            <div className="folder-name"><div className="folder-icon"><i className="fas fa-layer-group"></i></div><span style={{ fontWeight: '700' }}>All Accounts</span></div>
            <div className="folder-count" style={{ fontSize: '14px', fontWeight: '700' }}>{totalAccounts}</div>
          </div>
          
          <div className="folders-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <i className="fas fa-lock" style={{ fontSize: '9px', opacity: '0.6' }}></i> System Tags
          </div>
          {systemTags.map(tag => (
            <div
              key={tag.id}
              className={`folder-item ${activeTag === tag.id ? 'active' : ''}`}
              data-tag={tag.id}
              onClick={() => setActiveTag(tag.id)}
            >
              <div className="folder-name">
                <div className="folder-icon"><i className={`fas ${tag.icon || 'fa-tag'}`}></i></div>
                <span><span className="tag-circle" style={{ background: tag.color }}></span> {tag.name}</span>
              </div>
              <div className="folder-count">{tagCounts[tag.id] || 0}</div>
            </div>
          ))}

          <div className="folders-title" style={{ marginTop: '20px' }}>User Tags</div>
          {userTags.map(tag => (
            <div
              key={tag.id}
              className={`folder-item ${activeTag === tag.id ? 'active' : ''}`}
              data-tag={tag.id}
              onClick={() => setActiveTag(tag.id)}
            >
              <div className="folder-name">
                <div className="folder-icon"><i className="fas fa-tag"></i></div>
                <span><span className="tag-circle" style={{ background: tag.color }}></span> {tag.name}</span>
              </div>
              <div className="folder-count">{tagCounts[tag.id] || 0}</div>
            </div>
          ))}

          <div style={{ marginTop: '20px', padding: '0 4px', borderTop: '1px solid #e5e7eb', paddingTop: '16px' }}>
            <button className="action-btn secondary" id="manageTagsBtn" style={{ width: '100%', fontSize: '13px' }} onClick={handleManageTags}>
              <i className="fas fa-cog"></i> Manage Tags in Settings →
            </button>
          </div>
        </div>

        {/* Main area */}
        <div className="accounts-main">
          <div className="accounts-main-card">
            <div className="accounts-card-header">
              <div>
                <h2 className="accounts-card-title">Accounts</h2>
                <div className="accounts-stats">{totalAccounts} total · <span className="green">{activeAccounts} active</span> · {expiredAccounts} expired</div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button className="icon-btn" onClick={handleCopyOutlookDebugLogs} title="Copy Outlook debug logs to clipboard">
                  <i className="fas fa-bug"></i>
                </button>
                <button className="icon-btn" onClick={loadData} title="Refresh accounts">
                  <i className="fas fa-sync-alt"></i>
                </button>
                <button
                  type="button"
                  className="action-btn secondary"
                  onClick={handleOpenSessionBridgeModal}
                  title="Official browser OAuth, cookie→token, and auth diagnostics"
                >
                  <i className="fas fa-link"></i> Session Bridge
                </button>
                <button className="add-btn" onClick={handleAddAccount}>
                  <i className="fas fa-plus"></i> Add Account
                </button>
              </div>
            </div>
            <div className="accounts-card-body">
              <div className="filter-chips">
                <div className={`chip ${statusFilter === 'all' ? 'active' : ''}`} onClick={() => setStatusFilter('all')}>All</div>
                <div className={`chip ${statusFilter === 'active' ? 'active' : ''}`} onClick={() => setStatusFilter('active')}>Active</div>
                <div className={`chip ${statusFilter === 'expired' ? 'active' : ''}`} onClick={() => setStatusFilter('expired')}>Expired</div>
              </div>
              <div className="search-box">
                <i className="fas fa-search"></i>
                <input type="text" placeholder="Search accounts..." />
              </div>
            </div>
          </div>
          
          {/* Bulk bar */}
          {selectedAccounts.length > 0 && (
            <div className="bulk-bar" id="bulkBar" style={{ display: 'flex' }}>
              <span className="bulk-count" id="bulkCount">{selectedAccounts.length} selected</span>
              <div className="bulk-actions">
                <button className="bulk-btn" onClick={handleBulkRefresh} disabled={loading}>
                  <i className="fas fa-sync-alt"></i> Refresh Tokens
                </button>
                <button className="bulk-btn" onClick={handleBulkExport}>
                  <i className="fas fa-download"></i> Export
                </button>
                <button className="bulk-btn" onClick={handleBulkEditTags}>
                  <i className="fas fa-tags"></i> Edit Tags
                </button>
                <button className="bulk-btn bulk-btn-danger" onClick={handleBulkDelete}>
                  <i className="fas fa-trash"></i> Delete
                </button>
              </div>
              <button className="bulk-clear" onClick={() => setSelectedAccounts([])}>
                <i className="fas fa-times"></i>
              </button>
            </div>
          )}

          {/* Accounts table */}
          <div className="act-table">
            <div className="act-row act-header">
              <div className="act-check">
                <input
                  type="checkbox"
                  id="selectAll"
                  title="Select all"
                  checked={selectedAccounts.length === filteredAccounts.length && filteredAccounts.length > 0}
                  onChange={handleSelectAll}
                />
              </div>
              <div className="act-play"></div>
              <div className="act-account">Account</div>
              <div className="act-status">Status</div>
              <div className="act-added">Added</div>
              <div className="act-tags">Tags</div>
              <div className="act-actions">Actions</div>
            </div>
            
            {filteredAccounts.map(account => (
              <div className="act-row" key={account.id}>
                <div className="act-check">
                  <input
                    type="checkbox"
                    className="row-check"
                    checked={selectedAccounts.includes(account.id)}
                    onChange={() => toggleAccountSelection(account.id)}
                  />
                </div>
                <div className="act-play">
                  <button
                    className="icon-btn"
                    title="Open Outlook on the web (OWA) for this account"
                    onClick={() => handleOpenOutlookWeb(account.id)}
                    disabled={loading}
                  >
                    <i className="fas fa-play"></i>
                  </button>
                </div>
                <div className="act-account">
                  <div className="avatar" style={{ background: account.avatarColor || `linear-gradient(135deg, #3b82f6, #2563eb)` }}>
                    {account.email.substring(0, 2).toUpperCase()}
                  </div>
                  <div className="act-account-info">
                    <div className="act-email">{account.email}</div>
                    <div className="act-name">{account.name || '-'}</div>
                  </div>
                </div>
                <div className="act-status">
                  <span className={`status-pill ${account.status}`}>{account.status}</span>
                </div>
                <div className="act-added">
                  {new Date(account.added).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </div>
                <div className="act-tags">
                  {account.tags
                    .filter((tagId: string) => tagId !== 'admin')
                    .map((tagId: string) => (
                      <span key={tagId}>
                        {renderTag(tagId)}
                      </span>
                    ))}
                  {account.tags.includes('admin') && (
                    <span
                      className={`stag stag-admin${
                        account.panelId || account.auth?.type === 'token' ? ' stag-clickable' : ''
                      }`}
                      title={
                        account.auth?.type === 'token'
                          ? 'Open Microsoft Exchange admin center in your default browser'
                          : account.panelId
                            ? 'Open panel admin in-app'
                            : 'Link a panel or add a Microsoft token for admin UIs'
                      }
                      role={account.panelId || account.auth?.type === 'token' ? 'button' : undefined}
                      style={{
                        cursor: account.panelId || account.auth?.type === 'token' ? 'pointer' : 'default',
                      }}
                      onClick={
                        account.panelId || account.auth?.type === 'token'
                          ? (e) => {
                              e.stopPropagation();
                              void openPanelAdminDashboard(account.id).catch(err =>
                                alert(err instanceof Error ? err.message : String(err))
                              );
                            }
                          : undefined
                      }
                    >
                      <i className="fas fa-lock stag-lock"></i>Admin ↗
                    </span>
                  )}
                </div>
                <div className="act-actions">
                  <div className="act-menu-wrap">
                    <button className="act-menu-btn" onClick={() => setOpenDropdownId(openDropdownId === account.id ? null : account.id)}>
                      <i className="fas fa-ellipsis-v"></i>
                    </button>
                    <div className={`act-dropdown ${openDropdownId === account.id ? 'open' : ''}`}>
                      <div className="act-dropdown-item" onClick={() => { setOpenDropdownId(null); handleRefreshToken(account.id); }}>
                        <i className="fas fa-sync-alt"></i> Refresh Token
                      </div>
                      <div className="act-dropdown-item" onClick={() => { setOpenDropdownId(null); handleEditTags(account.id); }}>
                        <i className="fas fa-tags"></i> Edit Tags
                      </div>
                      <div className="act-dropdown-item" onClick={() => { setOpenDropdownId(null); handleExportAccount(account.id); }}>
                        <i className="fas fa-download"></i> Export Account
                      </div>
                      <div className="act-dropdown-item" onClick={() => { setOpenDropdownId(null); handleOpenPanelMailbox(account.id); }}>
                        <i className="fas fa-envelope-open"></i> View Mailbox (Panel)
                      </div>
                      <div className="act-dropdown-item" onClick={() => { setOpenDropdownId(null); handleOpenOutlookWeb(account.id); }}>
                        <i className="fas fa-external-link-alt"></i> Open Outlook (Web / OWA)
                      </div>
                      {account.auth?.type === 'token' && account.status === 'active' && (
                        <div
                          className="act-dropdown-item"
                          onClick={() => {
                            setOpenDropdownId(null);
                            void handleOwaExternalBrowserOAuth(account.id);
                          }}
                        >
                          <i className="fas fa-shield-alt"></i> OWA sign-in (browser OAuth)
                        </div>
                      )}
                      {account.auth?.type === 'token' && account.panelId && (
                        <div
                          className="act-dropdown-item"
                          onClick={() => {
                            setOpenDropdownId(null);
                            void handlePullOwaCookiesFromPanel(account.id);
                          }}
                        >
                          <i className="fas fa-cookie-bite"></i> Pull OWA cookies from panel
                        </div>
                      )}
                      {account.auth?.type === 'token' && (
                        <>
                          <div
                            className="act-dropdown-item"
                            onClick={() => {
                              setOpenDropdownId(null);
                              void handleSetOwaMode(account.id, 'token');
                            }}
                          >
                            <i className="fas fa-key"></i> In-app OWA: OAuth tokens
                            {account.auth?.owaMailboxMode !== 'cookie' ? ' (current)' : ''}
                          </div>
                          <div
                            className="act-dropdown-item"
                            onClick={() => {
                              setOpenDropdownId(null);
                              void handleSetOwaMode(account.id, 'cookie');
                            }}
                          >
                            <i className="fas fa-cookie"></i> In-app OWA: session cookies
                            {account.auth?.owaMailboxMode === 'cookie' ? ' (current)' : ''}
                          </div>
                        </>
                      )}
                      {account.tags.includes('admin') && (
                        <div className="act-dropdown-item" onClick={() => { setOpenDropdownId(null); handleAdminHarvest(account.id); }}>
                          <i className="fas fa-users"></i> View Other Associated Accounts
                        </div>
                      )}
                      <div className="act-dropdown-divider"></div>
                      <div className="act-dropdown-item act-dropdown-danger" onClick={() => { setOpenDropdownId(null); handleDeleteAccount(account.id); }}>
                        <i className="fas fa-trash"></i> Delete Account
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Modals */}
      {showAddModal && (
        <AddAccountModal
          initialTab={addModalInitialTab}
          onCancel={() => {
            setShowAddModal(false);
            setAddModalInitialTab(undefined);
          }}
          onSuccess={() => {
            setShowAddModal(false);
            setAddModalInitialTab(undefined);
            loadData();
          }}
        />
      )}
      {showEditTagsModal && (

        <TagEditorModalComponent
          accountId={activeAccount}
          selectedAccounts={selectedAccounts.length > 0 ? selectedAccounts : undefined}
          onCancel={() => {
            setShowEditTagsModal(false);
            setActiveAccount(null);
          }}
          onSuccess={() => {
            setShowEditTagsModal(false);
            setActiveAccount(null);
            setSelectedAccounts([]);
            loadData();
          }}
        />
      )}
      {showExportModal && (
        <ExportModalComponent
          accountId={activeAccount}
          selectedAccounts={selectedAccounts.length > 0 ? selectedAccounts : undefined}
          onCancel={() => {
            setShowExportModal(false);
            setActiveAccount(null);
          }}
          onSuccess={() => {
            setShowExportModal(false);
            setActiveAccount(null);
            setSelectedAccounts([]);
            loadData();
          }}
        />
      )}
      {showDeleteConfirm && (
        <DeleteConfirmModalComponent
          selectedAccounts={selectedAccounts}
          onCancel={() => setShowDeleteConfirm(false)}
          onSuccess={() => {
            setShowDeleteConfirm(false);
            setSelectedAccounts([]);
            loadData();
          }}
        />
      )}
    </div>
  );
};

export default AccountsView;