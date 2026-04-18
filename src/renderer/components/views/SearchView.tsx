import { useState, useEffect } from 'react';
import {
  getSearchQueue,
  addSearchJob,
  clearSearchQueue,
  runAllQueuedJobs,
  normalizeDateRange,
} from '../../services/searchService';
import { getSearchResults } from '../../services/searchService';
import { getAccounts } from '../../services/accountService';
import { getPanels } from '../../services/panelService';

const RESULTS_PER_PAGE = 50;

const SearchView = () => {
  const [queue, setQueue] = useState<any[]>([]);
  const [results, setResults] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [panels, setPanels] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [resultsPage, setResultsPage] = useState(1);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [filters, setFilters] = useState({
    accountSelect: '',
    foldersSelect: 'inbox',
    keywordsInput: '',
    dateFrom: '',
    dateTo: '',
    senderFilter: '',
    telegramAlert: false,
  });

  // Load data on mount
  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    setResultsPage(1);
  }, [results]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [queueData, resultsData, accountsData, panelsData] = await Promise.all([
        getSearchQueue(),
        getSearchResults(),
        getAccounts(),
        getPanels(),
      ]);
      setQueue(queueData);
      setResults(resultsData);
      setAccounts(accountsData);
      setPanels(panelsData);
    } catch (error) {
      console.error('Failed to load search data:', error);
    } finally {
      setLoading(false);
    }
  };

  // Add selected accounts to queue
  const handleAddToQueue = async () => {
    if (selectedAccountIds.length === 0) {
      alert('Please select at least one account');
      return;
    }
    const kw = filters.keywordsInput
      .split(',')
      .map(k => k.trim())
      .filter(Boolean);
    if (kw.length === 0) {
      alert('Add at least one keyword (comma-separated) to search the mailbox history.');
      return;
    }
    setLoading(true);
    try {
      for (const accountId of selectedAccountIds) {
        await addSearchJob({
          accountIds: [accountId],
          keywords: kw,
          folders: filters.foldersSelect === 'all' ? [] : [filters.foldersSelect],
          dateRange: normalizeDateRange(
            filters.dateFrom || filters.dateTo ? { start: filters.dateFrom, end: filters.dateTo } : {}
          ),
          senderFilter: filters.senderFilter || undefined,
          telegramAlert: filters.telegramAlert,
        });
      }
      setSelectedAccountIds([]);
      await loadData();
    } catch (error) {
      alert(`Failed to add to queue: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  // Toggle account selection
  const handleAccountToggle = (accountId: string) => {
    setSelectedAccountIds(prev =>
      prev.includes(accountId)
        ? prev.filter(id => id !== accountId)
        : [...prev, accountId]
    );
  };

  // Clear queue
  const handleClearQueue = async () => {
    if (!confirm('Clear the entire search queue?')) return;
    setLoading(true);
    try {
      await clearSearchQueue();
      await loadData();
    } catch (error) {
      alert(`Failed to clear queue: ${error}`);
    } finally {
      setLoading(false);
    }
  };



  // Start search
  const handleStartSearch = async () => {
    if (queue.length === 0) {
      alert('Queue is empty. Add accounts first.');
      return;
    }
    setSearching(true);
    try {
      await runAllQueuedJobs();
      await loadData();
    } catch (error) {
      alert(`Search failed: ${error}`);
    } finally {
      setSearching(false);
    }
  };

  // Get account email by ID
  const getAccountEmail = (accountId: string) => {
    const account = accounts.find(a => a.id === accountId);
    return account?.email || accountId;
  };

  // Get panel for account
  const getPanelForAccount = (accountId: string) => {
    const account = accounts.find(a => a.id === accountId);
    if (!account?.panelId) return null;
    return panels.find(p => p.id === account.panelId);
  };



  // Format date for display
  const formatDate = (iso?: string) => {
    if (!iso) return '';
    const date = new Date(iso);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };





  // Group accounts by panel
  const accountsByPanel: Record<string, any[]> = {};
  const accountsWithoutPanel: any[] = [];
  
  accounts.forEach(account => {
    const panel = getPanelForAccount(account.id);
    if (panel) {
      if (!accountsByPanel[panel.id]) {
        accountsByPanel[panel.id] = [];
      }
      accountsByPanel[panel.id].push(account);
    } else {
      accountsWithoutPanel.push(account);
    }
  });

  // Summary stats
  const uniqueAccounts = [...new Set(results.map(r => r.accountId))].length;
  const totalResults = results.length;
  const totalResultPages = Math.max(1, Math.ceil(totalResults / RESULTS_PER_PAGE));
  const safePage = Math.min(Math.max(resultsPage, 1), totalResultPages);
  const resultSliceStart = (safePage - 1) * RESULTS_PER_PAGE;
  const pagedResults = results.slice(resultSliceStart, resultSliceStart + RESULTS_PER_PAGE);

  if (loading && accounts.length === 0) {
    return <div id="searchView">Loading search data...</div>;
  }

  return (
    <div id="searchView">
      <div className="search-page">
        {/* Left column: Search parameters and queue */}
        <div className="db-card search-form-card">
          <div className="db-card-header">
            <span className="db-card-title">
              <i className="fas fa-search" style={{ color: '#3b82f6' }}></i> Search Parameters
            </span>
          </div>
          <p style={{ fontSize: '13px', color: '#475569', margin: '0 0 16px', lineHeight: 1.5 }}>
            Search mail that already arrived: pick accounts, keywords, optional folders and <strong>date range</strong>, then run.
            Monitoring alerts only cover <em>new</em> mail — use this view for the past. The mailbox API is queried with pagination (up to 10,000 hits per account/folder); use the table pager below when there are many rows.
          </p>
          <div className="form-group">
            <label className="form-label">Accounts to Search</label>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
              <button
                className="action-btn secondary"
                style={{ fontSize: '12px', padding: '4px 10px' }}
                onClick={() => {
                  const allIds = accounts.map(a => a.id);
                  setSelectedAccountIds(allIds);
                }}
                disabled={accounts.length === 0}
              >
                <i className="fas fa-check-square"></i> Select All
              </button>
              <button
                className="action-btn secondary"
                style={{ fontSize: '12px', padding: '4px 10px' }}
                onClick={() => setSelectedAccountIds([])}
                disabled={selectedAccountIds.length === 0}
              >
                <i className="fas fa-square"></i> Deselect All
              </button>
            </div>
            <div style={{
              border: '1px solid #e5e7eb',
              borderRadius: '6px',
              padding: '12px',
              maxHeight: '300px',
              overflowY: 'auto',
              background: '#f9fafb'
            }}>
              {Object.entries(accountsByPanel).map(([panelId, panelAccounts]) => {
                const panel = panels.find(p => p.id === panelId);
                return (
                  <div key={panelId} style={{ marginBottom: '16px' }}>
                    <div style={{
                      fontSize: '12px',
                      fontWeight: 700,
                      color: '#6b7280',
                      textTransform: 'uppercase',
                      marginBottom: '8px',
                      paddingBottom: '4px',
                      borderBottom: '1px solid #e5e7eb'
                    }}>
                      <i className="fas fa-server" style={{ marginRight: '6px' }}></i>
                      Panel: {panel?.name || panelId}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {panelAccounts.map(acc => (
                        <label key={acc.id} style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={selectedAccountIds.includes(acc.id)}
                            onChange={() => handleAccountToggle(acc.id)}
                            style={{ marginRight: '8px' }}
                          />
                          <span style={{ fontSize: '13px', color: '#374151' }}>{acc.email}</span>
                          {acc.tags?.map((tag: string) => (
                            <span key={tag} style={{
                              fontSize: '11px',
                              background: '#e5e7eb',
                              color: '#6b7280',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              marginLeft: '6px'
                            }}>{tag}</span>
                          ))}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
              {accountsWithoutPanel.length > 0 && (
                <div style={{ marginBottom: '16px' }}>
                  <div style={{
                    fontSize: '12px',
                    fontWeight: 700,
                    color: '#6b7280',
                    textTransform: 'uppercase',
                    marginBottom: '8px',
                    paddingBottom: '4px',
                    borderBottom: '1px solid #e5e7eb'
                  }}>
                    <i className="fas fa-question-circle" style={{ marginRight: '6px' }}></i>
                    No Panel
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {accountsWithoutPanel.map(acc => (
                      <label key={acc.id} style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={selectedAccountIds.includes(acc.id)}
                          onChange={() => handleAccountToggle(acc.id)}
                          style={{ marginRight: '8px' }}
                        />
                        <span style={{ fontSize: '13px', color: '#374151' }}>{acc.email}</span>
                        {acc.tags?.map((tag: string) => (
                          <span key={tag} style={{
                            fontSize: '11px',
                            background: '#e5e7eb',
                            color: '#6b7280',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            marginLeft: '6px'
                          }}>{tag}</span>
                        ))}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {accounts.length === 0 && (
                <div style={{ textAlign: 'center', color: '#9ca3af', padding: '20px' }}>
                  No accounts available. Add accounts in the Accounts view.
                </div>
              )}
            </div>
            <div className="form-helper" style={{ marginTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', color: '#6b7280' }}>
                Selected: <strong>{selectedAccountIds.length}</strong> account(s)
              </span>
              <button
                className="action-btn primary"
                style={{ fontSize: '12px', padding: '4px 10px' }}
                onClick={handleAddToQueue}
                disabled={selectedAccountIds.length === 0 || loading}
              >
                <i className="fas fa-plus"></i> Add to Queue
              </button>
            </div>
          </div>

          {/* Queue */}
          <div id="searchQueue" style={{ border: '1px solid #e5e7eb', borderRadius: '8px', marginBottom: '16px' }}>
            <div style={{
              padding: '8px 12px',
              background: '#f9fafb',
              fontSize: '11px',
              fontWeight: 700,
              color: '#6b7280',
              textTransform: 'uppercase',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <span>Queue ({queue.length} at a time)</span>
              <button
                onClick={handleClearQueue}
                style={{ fontSize: '11px', color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer' }}
                disabled={queue.length === 0 || loading}
              >
                Clear
              </button>
            </div>
            {queue.length === 0 ? (
              <div style={{ padding: '12px', textAlign: 'center', color: '#9ca3af' }}>
                Queue is empty. Add accounts above.
              </div>
            ) : (
              queue.map(job => (
                <div className="search-queue-item" key={job.id}>
                  <span className={`sq-badge sq-${job.status}`}>
                    {job.status.charAt(0).toUpperCase() + job.status.slice(1)}
                  </span>
                  {getAccountEmail(job.accountIds[0])}
                </div>
              ))
            )}
          </div>

          <div className="form-group">
            <label className="form-label">Folders</label>
            <select
              className="select"
              style={{ width: '100%' }}
              value={filters.foldersSelect}
              onChange={(e) => setFilters({ ...filters, foldersSelect: e.target.value })}
            >
              <option value="all">Entire Mailbox</option>
              <option value="inbox">Inbox</option>
              <option value="sent">Sent</option>
              <option value="drafts">Drafts</option>
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">Keywords</label>
            <textarea
              className="form-input"
              rows={2}
              placeholder="invoice, payment, contract..."
              value={filters.keywordsInput}
              onChange={(e) => setFilters({ ...filters, keywordsInput: e.target.value })}
            />
            <div className="form-helper">Comma-separated.</div>
          </div>

          <div className="form-group">
            <label className="form-label">Date From (older boundary)</label>
            <input
              type="date"
              className="form-input"
              style={{ width: '100%' }}
              value={filters.dateFrom}
              onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value })}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Date To (newer boundary)</label>
            <input
              type="date"
              className="form-input"
              style={{ width: '100%' }}
              value={filters.dateTo}
              onChange={(e) => setFilters({ ...filters, dateTo: e.target.value })}
            />
            <div className="form-helper" style={{ marginTop: 6 }}>
              Mail must fall between these days (inclusive). If From is after To, they are swapped automatically.
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Sender Filter</label>
            <input
              type="text"
              className="form-input"
              placeholder="@bank.com or ceo@company.com"
              value={filters.senderFilter}
              onChange={(e) => setFilters({ ...filters, senderFilter: e.target.value })}
            />
          </div>

          <div className="toggle-row" style={{ marginBottom: '16px' }}>
            <span className="toggle-label">Notify via Telegram</span>
            <div
              className={`toggle ${filters.telegramAlert ? 'active' : ''}`}
              onClick={() => setFilters({ ...filters, telegramAlert: !filters.telegramAlert })}
            >
              <div className="toggle-knob"></div>
            </div>
          </div>

          <button
            className="action-btn primary"
            style={{ width: '100%' }}
            onClick={handleStartSearch}
            disabled={queue.length === 0 || searching || loading}
          >
            <i className="fas fa-play"></i> {searching ? 'Searching...' : 'Start Search'}
          </button>
        </div>

        {/* Right column: Results */}
        <div>
          <div className="search-stat-banner">
            Found <strong>{totalResults} results</strong> across <strong>{uniqueAccounts} accounts</strong>
            {totalResults > RESULTS_PER_PAGE && (
              <span style={{ marginLeft: 8, fontWeight: 400, color: '#64748b' }}>
                (showing {RESULTS_PER_PAGE} per page)
              </span>
            )}
          </div>

          <div className="search-results-card">
            <div className="findings-table">
              <div className="ft-row ft-header">
                <div className="ft-time">Date</div>
                <div className="ft-account">Account</div>
                <div className="ft-panel">Folder</div>
                <div className="ft-details">Subject / Match</div>
                <div className="ft-actions">Open</div>
              </div>
              {results.length === 0 ? (
                <div className="ft-row" style={{ justifyContent: 'center', padding: '20px', color: '#9ca3af' }}>
                  No results yet. Run a search.
                </div>
              ) : (
                pagedResults.map(result => {
                  const account = accounts.find(a => a.id === result.accountId);
                  return (
                    <div className="ft-row" key={result.id}>
                      <div className="ft-time">{formatDate(result.date)}</div>
                      <div className="ft-account">{account?.email || result.accountId}</div>
                      <div className="ft-panel" style={{ color: '#374151', fontSize: '13px', fontWeight: 500 }}>
                        {result.folder || '—'}
                      </div>
                      <div className="ft-details">
                        &ldquo;{result.subject?.substring(0, 60)}&rdquo; &mdash; keywords:{' '}
                        <strong>{result.keywords?.length ? result.keywords.join(', ') : '—'}</strong>
                      </div>
                      <div className="ft-actions">
                        <button
                          className="icon-btn"
                          onClick={() => alert('Open email not implemented')}
                          title="Open email"
                        >
                          <i className="fas fa-eye"></i>
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            {totalResults > 0 && (
              <div
                className="search-results-pager"
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: '1px solid #e2e8f0',
                }}
              >
                <span style={{ fontSize: 13, color: '#64748b' }}>
                  Showing{' '}
                  <strong>
                    {totalResults === 0 ? 0 : resultSliceStart + 1}–{resultSliceStart + pagedResults.length}
                  </strong>{' '}
                  of <strong>{totalResults}</strong>
                </span>
                {totalResultPages > 1 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button
                      type="button"
                      className="action-btn secondary"
                      style={{ padding: '6px 14px', fontSize: 13 }}
                      disabled={safePage <= 1}
                      onClick={() => setResultsPage(p => Math.max(1, p - 1))}
                    >
                      <i className="fas fa-chevron-left" /> Previous
                    </button>
                    <span style={{ fontSize: 13, color: '#475569', minWidth: 100, textAlign: 'center' }}>
                      Page {safePage} of {totalResultPages}
                    </span>
                    <button
                      type="button"
                      className="action-btn secondary"
                      style={{ padding: '6px 14px', fontSize: 13 }}
                      disabled={safePage >= totalResultPages}
                      onClick={() => setResultsPage(p => Math.min(totalResultPages, p + 1))}
                    >
                      Next <i className="fas fa-chevron-right" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SearchView;
