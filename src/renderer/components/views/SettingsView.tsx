import { useState, useEffect } from 'react';
import { getSettings, updateSettings } from '../../services/settingsService';
import { websocketManager } from '../../services/websocketService';
import { setOutlookMockMode } from '../../services/outlookService';
import { Tag } from '../../../types/store';
import { createUserTag, updateUserTag, deleteUserTag } from '../../services/tagService';
import { getAccounts } from '../../services/accountService';

const SettingsView = () => {
  const [settings, setSettings] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string>('');

  // Load settings on mount
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const data = await getSettings();
      setSettings(data);
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const updateSetting = (path: string, value: any) => {
    setSettings((prev: any) => {
      const newSettings = JSON.parse(JSON.stringify(prev));
      const keys = path.split('.');
      let obj = newSettings;
      for (let i = 0; i < keys.length - 1; i++) {
        if (obj[keys[i]] === undefined || obj[keys[i]] === null) {
          obj[keys[i]] = {};
        }
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = value;
      return newSettings;
    });
  };

  const handleSaveSettings = async () => {
    try {
      await updateSettings(settings);
      // Refresh WebSocket connections if sync settings changed
      websocketManager.refreshConnections().catch(err => console.error('Failed to refresh WebSocket connections:', err));
      // Re-apply the OutlookService mock-mode flag in case Debug → Use mock
      // Outlook API was just toggled.
      setOutlookMockMode(
        !!(settings.debug?.useMockOutlookApi ?? settings.debug?.useMockGraphApi)
      );
      showToast('Settings saved successfully!');
    } catch (error) {
      showToast('Failed to save settings.');
      console.error(error);
    }
  };

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(''), 3000);
  };

  // Tag management
  const handleCreateTag = async () => {
    const name = (document.getElementById('newTagName') as HTMLInputElement)?.value?.trim();
    const color = (document.getElementById('newTagColor') as HTMLInputElement)?.value || '#3b82f6';
    if (!name) return;
    try {
      const newTag = await createUserTag({ name, color });
      // Update local settings state
      const updatedTags = [...(settings.tags.userTags || []), newTag];
      updateSetting('tags.userTags', updatedTags);
      (document.getElementById('newTagName') as HTMLInputElement).value = '';
      showToast(`Tag "${name}" created`);
    } catch (error: any) {
      showToast(`Failed to create tag: ${error.message}`);
    }
  };

  const handleUpdateTag = async (index: number, field: 'name' | 'color', value: string) => {
    const tag = settings.tags.userTags[index];
    if (!tag) return;
    try {
      const updatedTag = await updateUserTag(tag.id, { [field]: value });
      // Update local settings state
      const updated = [...settings.tags.userTags];
      updated[index] = updatedTag;
      updateSetting('tags.userTags', updated);
    } catch (error: any) {
      showToast(`Failed to update tag: ${error.message}`);
    }
  };

  const handleDeleteTag = async (index: number) => {
    const tag = settings.tags.userTags[index];
    if (!tag) return;
    if (!confirm('Delete this tag? This will remove it from all accounts.')) return;
    try {
      await deleteUserTag(tag.id);
      // Update local settings state
      const updated = [...settings.tags.userTags];
      updated.splice(index, 1);
      updateSetting('tags.userTags', updated);
      showToast('Tag deleted');
    } catch (error: any) {
      showToast(`Failed to delete tag: ${error.message}`);
    }
  };

  // Test Telegram bot (real IPC)
  const handleTestTelegram = async (bot: string) => {
    try {
      const result = await window.electron.actions.telegramTest(bot);
      if (result.success) {
        showToast(`Test message sent via ${bot} bot`);
      } else {
        showToast(`Telegram (${bot}): ${result.error || 'failed'}`);
      }
    } catch (error) {
      showToast(`Error: ${error}`);
    }
  };

  // Import tokens from JSON file (mock file picker)
  const handleImportTokens = async () => {
    try {
      // In a real app we'd open a file picker and get a path
      const result = await window.electron.actions.importTokens('tokens.json');
      if (result.success) {
        showToast(`Imported ${result.count || 0} tokens`);
      } else {
        showToast('Import failed');
      }
    } catch (error) {
      showToast(`Error: ${error}`);
    }
  };

  // Export tokens to JSON file (mock file picker)
  const handleExportTokens = async () => {
    try {
      const result = await window.electron.actions.exportTokens('tokens.json');
      if (result.success) {
        showToast(`Tokens exported to ${result.path}`);
      } else {
        showToast('Export failed');
      }
    } catch (error) {
      showToast(`Error: ${error}`);
    }
  };

  // Clear activity feed
  const handleClearActivity = async () => {
    try {
      const result = await window.electron.actions.clearActivity();
      if (result.success) {
        showToast('Activity feed cleared');
      } else {
        showToast('Failed to clear activity feed');
      }
    } catch (error) {
      showToast(`Error: ${error}`);
    }
  };

  // Check updates (mock)
  const handleCheckUpdates = () => {
    alert('[SIMULATED] Checking latest release on GitHub...');
  };

  const handleCopyDebugBundle = async () => {
    try {
      const [accounts, outlookLogs] = await Promise.all([
        getAccounts(),
        window.electron.actions.getOutlookDebugLogs().catch(() => ({ success: false, text: '', lines: 0 })),
      ]);
      const summary = {
        generatedAt: new Date().toISOString(),
        app: {
          version: settings.version,
          platform: settings.platform,
        },
        counts: {
          accounts: accounts.length,
          tokenAccounts: accounts.filter(a => a.auth?.type === 'token').length,
          activeAccounts: accounts.filter(a => a.status === 'active').length,
          expiredAccounts: accounts.filter(a => a.status === 'expired').length,
          errorAccounts: accounts.filter(a => a.status === 'error').length,
        },
        ai: {
          analysisMode: settings.ai?.analysisMode,
          model: settings.ai?.openaiModel,
          fullBody: settings.ai?.useFullBodyForAnalysis,
        },
        microsoftOAuth: settings.microsoftOAuth,
        sync: settings.sync,
        refresh: settings.refresh,
      };
      const redact = (txt: string) =>
        txt
          .replace(/([?&#](?:code|id_token|access_token|refresh_token|client_info|session_state)=)[^&\s]+/gi, '$1[REDACTED]')
          .replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, '$1[REDACTED]');
      const payload =
        `# Watcher Debug Bundle\n` +
        `${JSON.stringify(summary, null, 2)}\n\n` +
        `# Outlook Debug Logs (${outlookLogs.lines || 0} lines)\n` +
        `${redact((outlookLogs.text || '').slice(-15000))}`;
      await navigator.clipboard.writeText(payload);
      showToast('Debug bundle copied to clipboard');
    } catch (error) {
      console.error(error);
      showToast('Failed to copy debug bundle');
    }
  };

  if (loading || !settings) {
    return <div className="settings-grid">Loading settings...</div>;
  }

  
  const maxEventsOptions = [5, 10, 20, 50];
  const dashboardRefreshOptions = [
    { label: 'Off', value: 0 },
    { label: '30s', value: 30 },
    { label: '1 min', value: 60 },
    { label: '5 min', value: 300 },
  ];

  return (
    <div id="settingsView">
      <div className="settings-grid">
        {/* Sync & Refresh */}
        <div className="settings-card">
          <h3 className="settings-title">
            <span className="settings-icon"><i className="fas fa-sync"></i></span> Sync & Refresh
          </h3>
          <div className="toggle-row">
            <span className="toggle-label">Background panel sync</span>
            <div
              className={`toggle ${settings.sync.autoSync ? 'active' : ''}`}
              onClick={() => updateSetting('sync.autoSync', !settings.sync.autoSync)}
            >
              <div className="toggle-knob"></div>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Auto-sync interval (minutes)</label>
            <input
              type="number"
              className="form-input"
              min="0"
              step="1"
              value={settings.sync.intervalMinutes}
              onChange={(e) => updateSetting('sync.intervalMinutes', Number(e.target.value))}
            />
            <div className="form-helper">Set to 0 for manual only. Interval for syncing panel accounts.</div>
          </div>
          <div className="form-group">
            <label className="form-label">Token refresh interval (minutes)</label>
            <input
              type="number"
              className="form-input"
              min="0"
              step="1"
              value={settings.refresh.intervalMinutes}
              onChange={(e) => updateSetting('refresh.intervalMinutes', Number(e.target.value))}
            />
            <div className="form-helper">Accounts with "autorefresh" tag refresh tokens at this interval. Set to 0 to disable.</div>
          </div>
          <div className="toggle-row">
            <span className="toggle-label">Background token refresh</span>
            <div
              className={`toggle ${settings.refresh.autoRefresh ? 'active' : ''}`}
              onClick={() => updateSetting('refresh.autoRefresh', !settings.refresh.autoRefresh)}
            >
              <div className="toggle-knob"></div>
            </div>
          </div>
          <div className="toggle-row">
            <span className="toggle-label">Auto-reconnect on launch</span>
            <div
              className={`toggle ${settings.sync.autoReconnect ? 'active' : ''}`}
              onClick={() => updateSetting('sync.autoReconnect', !settings.sync.autoReconnect)}
            >
              <div className="toggle-knob"></div>
            </div>
          </div>
          <div className="toggle-row">
            <span className="toggle-label">Real‑time sync via WebSocket</span>
            <div
              className={`toggle ${settings.sync.realTimeWebSocket ? 'active' : ''}`}
              onClick={() => updateSetting('sync.realTimeWebSocket', !settings.sync.realTimeWebSocket)}
            >
              <div className="toggle-knob"></div>
            </div>
          </div>
        </div>

        {/* Microsoft OAuth (device code + cookie → token) */}
        <div className="settings-card">
          <h3 className="settings-title">
            <span className="settings-icon"><i className="fab fa-microsoft"></i></span> Microsoft OAuth
          </h3>
          <p className="form-helper" style={{ marginBottom: 12 }}>
            Used for <strong>device code</strong> sign-in and <strong>cookie → token</strong> conversion (PKCE). Use the first-party Office client ID unless you register your own app; redirect must match your app registration (default matches Outlook web).
          </p>
          <div className="form-group">
            <label className="form-label">Application (client) ID</label>
            <input
              type="text"
              className="form-input"
              value={settings.microsoftOAuth?.clientId ?? ''}
              onChange={e => updateSetting('microsoftOAuth.clientId', e.target.value)}
              placeholder="d3590ed6-52b3-4102-aeff-aad2292ab01c"
            />
          </div>
          <div className="form-group">
            <label className="form-label">Tenant / authority</label>
            <input
              type="text"
              className="form-input"
              value={settings.microsoftOAuth?.tenantId ?? 'common'}
              onChange={e => updateSetting('microsoftOAuth.tenantId', e.target.value)}
              placeholder="common or tenant GUID"
            />
            <div className="form-helper">Use <code>common</code> for multi-tenant / personal work accounts.</div>
          </div>
          <div className="form-group">
            <label className="form-label">Redirect URI (cookie conversion)</label>
            <input
              type="text"
              className="form-input"
              value={settings.microsoftOAuth?.redirectUri ?? ''}
              onChange={e => updateSetting('microsoftOAuth.redirectUri', e.target.value)}
              placeholder="https://outlook.office.com/mail/"
            />
          </div>
        </div>

        {/* Token Storage */}
        <div className="settings-card">
          <h3 className="settings-title">
            <span className="settings-icon"><i className="fas fa-key"></i></span> Token Storage
          </h3>
          <div className="form-group">
            <label className="form-label">Encryption Password</label>
            <input
              type="password"
              className="form-input"
              placeholder="Leave blank to keep current"
              value={settings.storage.encryptionPassword || ''}
              onChange={(e) => updateSetting('storage.encryptionPassword', e.target.value)}
            />
          </div>
          <div className="toggle-row">
            <span className="toggle-label">Store credentials locally</span>
            <div
              className={`toggle ${settings.storage.localCredentials ? 'active' : ''}`}
              onClick={() => updateSetting('storage.localCredentials', !settings.storage.localCredentials)}
            >
              <div className="toggle-knob"></div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '10px' }}>
            <button className="action-btn secondary" onClick={handleImportTokens}>
              <i className="fas fa-upload"></i> Import Tokens
            </button>
            <button className="action-btn secondary" onClick={handleExportTokens}>
              <i className="fas fa-download"></i> Export Tokens
            </button>
          </div>
        </div>

        {/* Telegram Alerts & Notifications */}
        <div className="settings-card full">
          <h3 className="settings-title">
            <span className="settings-icon"><i className="fas fa-bell"></i></span> Telegram Alerts & Notifications
          </h3>
          <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '20px' }}>
            Separate bot configurations for monitoring alerts and new account notifications.
          </div>

          {/* Monitoring Alerts */}
          <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '10px', padding: '20px', marginBottom: '20px' }}>
            <h4 style={{ fontSize: '16px', fontWeight: '600', color: '#0369a1', marginBottom: '16px' }}>
              <i className="fas fa-eye"></i> Monitoring Alerts
            </h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '20px' }}>
              <div className="form-group">
                <label className="form-label">Bot Token</label>
                <input
                  type="password"
                  className="form-input"
                  placeholder="Enter Telegram bot token"
                  value={settings.telegram.monitoring?.token || ''}
                  onChange={(e) => updateSetting('telegram.monitoring.token', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Chat ID</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Chat ID"
                  value={settings.telegram.monitoring?.chatId || ''}
                  onChange={(e) => updateSetting('telegram.monitoring.chatId', e.target.value)}
                />
              </div>
            </div>
            <div className="toggle-row">
              <span className="toggle-label">Enable monitoring alerts</span>
              <div
                className={`toggle ${settings.telegram.monitoring?.enabled ? 'active' : ''}`}
                onClick={() => updateSetting('telegram.monitoring.enabled', !settings.telegram.monitoring?.enabled)}
              >
                <div className="toggle-knob"></div>
              </div>
            </div>
            <div className="toggle-row">
              <span className="toggle-label">Only alert on keyword matches</span>
              <div
                className={`toggle ${settings.telegram.monitoring?.keywordOnly ? 'active' : ''}`}
                onClick={() => updateSetting('telegram.monitoring.keywordOnly', !settings.telegram.monitoring?.keywordOnly)}
              >
                <div className="toggle-knob"></div>
              </div>
            </div>
            <button
              className="action-btn secondary"
              style={{ marginTop: '12px', flex: 'none' }}
              onClick={() => handleTestTelegram('monitoring')}
            >
              <i className="fas fa-paper-plane"></i> Send Test Message
            </button>
          </div>

          {/* New Accounts/Sessions Notifications */}
          <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '10px', padding: '20px', marginBottom: '20px' }}>
            <h4 style={{ fontSize: '16px', fontWeight: '600', color: '#0369a1', marginBottom: '16px' }}>
              <i className="fas fa-user-plus"></i> New Accounts/Sessions Notifications
            </h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '20px' }}>
              <div className="form-group">
                <label className="form-label">Bot Token</label>
                <input
                  type="password"
                  className="form-input"
                  placeholder="Enter Telegram bot token"
                  value={settings.telegram.accounts?.token || ''}
                  onChange={(e) => updateSetting('telegram.accounts.token', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Chat ID</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Chat ID"
                  value={settings.telegram.accounts?.chatId || ''}
                  onChange={(e) => updateSetting('telegram.accounts.chatId', e.target.value)}
                />
              </div>
            </div>
            <div className="toggle-row">
              <span className="toggle-label">Enable new accounts/sessions notifications</span>
              <div
                className={`toggle ${settings.telegram.accounts?.enabled ? 'active' : ''}`}
                onClick={() => updateSetting('telegram.accounts.enabled', !settings.telegram.accounts?.enabled)}
              >
                <div className="toggle-knob"></div>
              </div>
            </div>
            <div className="toggle-row">
              <span className="toggle-label">Notify new tokens</span>
              <div
                className={`toggle ${settings.telegram.accounts?.notifyTokens ? 'active' : ''}`}
                onClick={() => updateSetting('telegram.accounts.notifyTokens', !settings.telegram.accounts?.notifyTokens)}
              >
                <div className="toggle-knob"></div>
              </div>
            </div>
            <button
              className="action-btn secondary"
              style={{ marginTop: '12px', flex: 'none' }}
              onClick={() => handleTestTelegram('accounts')}
            >
              <i className="fas fa-paper-plane"></i> Send Test Message
            </button>
          </div>

          {/* Account Search Results */}
          <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '10px', padding: '20px' }}>
            <h4 style={{ fontSize: '16px', fontWeight: '600', color: '#0369a1', marginBottom: '16px' }}>
              <i className="fas fa-search"></i> Account Search Results
            </h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '20px' }}>
              <div className="form-group">
                <label className="form-label">Bot Token</label>
                <input
                  type="password"
                  className="form-input"
                  placeholder="Bot token"
                  value={settings.telegram.search?.token || ''}
                  onChange={(e) => updateSetting('telegram.search.token', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Chat ID</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Chat ID"
                  value={settings.telegram.search?.chatId || ''}
                  onChange={(e) => updateSetting('telegram.search.chatId', e.target.value)}
                />
              </div>
            </div>
            <div className="toggle-row">
              <span className="toggle-label">Send results to Telegram</span>
              <div
                className={`toggle ${settings.telegram.search?.enabled ? 'active' : ''}`}
                onClick={() => updateSetting('telegram.search.enabled', !settings.telegram.search?.enabled)}
              >
                <div className="toggle-knob"></div>
              </div>
            </div>
            <div className="toggle-row">
              <span className="toggle-label">Include email snippets</span>
              <div
                className={`toggle ${settings.telegram.search?.includeSnippets ? 'active' : ''}`}
                onClick={() => updateSetting('telegram.search.includeSnippets', !settings.telegram.search?.includeSnippets)}
              >
                <div className="toggle-knob"></div>
              </div>
            </div>
            <button
              className="action-btn secondary"
              style={{ marginTop: '12px', flex: 'none' }}
              onClick={() => handleTestTelegram('search')}
            >
              <i className="fas fa-paper-plane"></i> Send Test Message
            </button>
          </div>
        </div>

        {/* Tag Management */}
        <div className="settings-card full">
          <h3 className="settings-title">
            <span className="settings-icon"><i className="fas fa-tags"></i></span> Tag Management
          </h3>
          <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '20px' }}>
            Tags organize your accounts. <strong>System tags</strong> (panel name, Admin, autorefresh) are auto-assigned and locked. <strong>User tags</strong> are custom — create, rename, recolour, or delete them here.
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
            {/* Left: System Tags (read‑only) */}
            <div>
              <div className="tm-section-title">
                <i className="fas fa-lock" style={{ fontSize: '11px', opacity: '0.6' }}></i> System Tags <span className="tm-badge">Auto‑assigned · Locked</span>
              </div>

              <div className="tm-tag-row">
                <span className="stag stag-admin"><i className="fas fa-lock stag-lock"></i>Admin</span>
                <span className="tm-tag-desc">Auto‑detected admin accounts from panel</span>
              </div>
              <div className="tm-tag-row">
                <span className="stag stag-autorefresh"><i className="fas fa-lock stag-lock"></i>autorefresh</span>
                <span className="tm-tag-desc">Enables token auto‑refresh – interval: 1h</span>
              </div>
              <div className="tm-tag-row">
                <span className="stag stag-cookie"><i className="fas fa-lock stag-lock"></i>Cookie‑Import</span>
                <span className="tm-tag-desc">Assigned to accounts added via cookie import</span>
              </div>
              <div className="tm-tag-row">
                <span className="stag stag-credential"><i className="fas fa-lock stag-lock"></i>Credential</span>
                <span className="tm-tag-desc">Assigned to accounts added via email/password</span>
              </div>
              <div className="tm-tag-row">
                <span className="stag stag-detached"><i className="fas fa-lock stag-lock"></i>Detached</span>
                <span className="tm-tag-desc">Panel deleted – account preserved</span>
              </div>
              <div className="form-helper" style={{ marginTop: '12px', padding: '10px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: '8px', color: '#0369a1' }}>
                <i className="fas fa-info-circle"></i> System tags cannot be renamed or deleted. To change the autorefresh interval, go to <strong>Sync & Refresh</strong> above.
              </div>
            </div>

            {/* Right: User Tags (editable) */}
            <div>
              <div className="tm-section-title">
                <i className="fas fa-tag" style={{ fontSize: '11px' }}></i> User Tags <span className="tm-badge tm-badge-user">Editable</span>
              </div>

              {settings.tags.userTags.map((tag: Tag, index: number) => (
                <div className="tm-tag-row tm-tag-editable" key={tag.id}>
                  <span className="tm-dot" style={{ background: tag.color }}></span>
                  <input
                    type="text"
                    className="form-input tm-new-name"
                    style={{ width: '100px', fontSize: '13px', padding: '4px 8px' }}
                    value={tag.name}
                    onChange={(e) => handleUpdateTag(index, 'name', e.target.value)}
                  />
                  <span className="tm-used">{tag.count || 0} accounts</span>
                  <input
                    type="color"
                    value={tag.color}
                    className="tm-color-input"
                    title="Change colour"
                    onChange={(e) => handleUpdateTag(index, 'color', e.target.value)}
                  />
                  <button
                    className="icon-btn"
                    style={{ width: '26px', height: '26px', fontSize: '11px' }}
                    title="Save"
                    onClick={() => showToast(`Tag "${tag.name}" saved`)}
                  >
                    <i className="fas fa-save"></i>
                  </button>
                  <button
                    className="icon-btn"
                    style={{ width: '26px', height: '26px', fontSize: '11px', color: '#dc2626' }}
                    title="Delete"
                    onClick={() => handleDeleteTag(index)}
                  >
                    <i className="fas fa-trash"></i>
                  </button>
                </div>
              ))}

              {/* Create New Tag */}
              <div className="tm-create-row">
                <input
                  type="text"
                  className="form-input tm-new-name"
                  placeholder="New tag name..."
                  id="newTagName"
                />
                <input
                  type="color"
                  defaultValue="#3b82f6"
                  className="tm-color-input"
                  id="newTagColor"
                  title="Pick colour"
                />
                <button
                  className="action-btn primary"
                  style={{ flex: 'none', padding: '8px 16px', fontSize: '13px' }}
                  onClick={handleCreateTag}
                >
                  <i className="fas fa-plus"></i> Add
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Dashboard – Recent Activity */}
        <div className="settings-card full">
          <h3 className="settings-title">
            <span className="settings-icon"><i className="fas fa-history"></i></span> Dashboard – Recent Activity
          </h3>
          <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '20px' }}>
            Controls what appears in the dashboard Recent Activity feed.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
            <div>
              <div className="form-group">
                <label className="form-label">Max events</label>
                <select
                  className="select"
                  value={settings.dashboard.maxEvents}
                  onChange={(e) => updateSetting('dashboard.maxEvents', Number(e.target.value))}
                >
                  {maxEventsOptions.map(num => (
                    <option key={num} value={num}>{num}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Auto‑refresh</label>
                <select
                  className="select"
                  value={settings.dashboard.autoRefresh}
                  onChange={(e) => updateSetting('dashboard.autoRefresh', Number(e.target.value))}
                >
                  {dashboardRefreshOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <div className="form-label" style={{ marginBottom: '12px' }}>Show in dashboard feed</div>
              <div className="toggle-row">
                <span className="toggle-label"><i className="fas fa-key" style={{ width: '14px', color: '#8b5cf6' }}></i> Token refreshed</span>
                <div
                  className={`toggle ${settings.dashboard.showTokenRefreshed ? 'active' : ''}`}
                  onClick={() => updateSetting('dashboard.showTokenRefreshed', !settings.dashboard.showTokenRefreshed)}
                >
                  <div className="toggle-knob"></div>
                </div>
              </div>
              <div className="toggle-row">
                <span className="toggle-label"><i className="fas fa-bell" style={{ width: '14px', color: '#f59e0b' }}></i> Monitoring alerts</span>
                <div
                  className={`toggle ${settings.dashboard.showMonitoringAlerts ? 'active' : ''}`}
                  onClick={() => updateSetting('dashboard.showMonitoringAlerts', !settings.dashboard.showMonitoringAlerts)}
                >
                  <div className="toggle-knob"></div>
                </div>
              </div>
              <div className="toggle-row">
                <span className="toggle-label"><i className="fas fa-sync" style={{ width: '14px', color: '#10b981' }}></i> Panel synced</span>
                <div
                  className={`toggle ${settings.dashboard.showPanelSynced ? 'active' : ''}`}
                  onClick={() => updateSetting('dashboard.showPanelSynced', !settings.dashboard.showPanelSynced)}
                >
                  <div className="toggle-knob"></div>
                </div>
              </div>
              <div className="toggle-row">
                <span className="toggle-label"><i className="fas fa-exclamation-triangle" style={{ width: '14px', color: '#dc2626' }}></i> Token expired</span>
                <div
                  className={`toggle ${settings.dashboard.showTokenExpired ? 'active' : ''}`}
                  onClick={() => updateSetting('dashboard.showTokenExpired', !settings.dashboard.showTokenExpired)}
                >
                  <div className="toggle-knob"></div>
                </div>
              </div>
              <div className="toggle-row">
                <span className="toggle-label"><i className="fas fa-plug" style={{ width: '14px', color: '#6b7280' }}></i> Panel connected/disconnected</span>
                <div
                  className={`toggle ${settings.dashboard.showPanelConnection ? 'active' : ''}`}
                  onClick={() => updateSetting('dashboard.showPanelConnection', !settings.dashboard.showPanelConnection)}
                >
                  <div className="toggle-knob"></div>
                </div>
              </div>
              <div className="toggle-row">
                <span className="toggle-label"><i className="fas fa-envelope" style={{ width: '14px', color: '#6366f1' }}></i> Account Search results</span>
                <div
                  className={`toggle ${settings.dashboard.showSearchResults ? 'active' : ''}`}
                  onClick={() => updateSetting('dashboard.showSearchResults', !settings.dashboard.showSearchResults)}
                >
                  <div className="toggle-knob"></div>
                </div>
              </div>
              <div className="toggle-row">
                <span className="toggle-label"><i className="fas fa-user-plus" style={{ width: '14px', color: '#3b82f6' }}></i> Account added/harvested</span>
                <div
                  className={`toggle ${settings.dashboard.showAccountAdded ? 'active' : ''}`}
                  onClick={() => updateSetting('dashboard.showAccountAdded', !settings.dashboard.showAccountAdded)}
                >
                  <div className="toggle-knob"></div>
                </div>
              </div>
            </div>
          </div>
          <div style={{ marginTop: '16px' }}>
            <button className="action-btn secondary" onClick={handleClearActivity}>
              <i className="fas fa-trash"></i> Clear Activity Feed
            </button>
          </div>
        </div>

        {/* About */}
        <div className="settings-card full">
          <h3 className="settings-title">
            <span className="settings-icon"><i className="fas fa-info-circle"></i></span> About
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px' }}>
            <div>
              <div style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '4px' }}>Version</div>
              <div style={{ fontSize: '16px', fontWeight: '600', color: '#111827' }}>{settings.version || '0.1.0'}</div>
            </div>
            <div>
              <div style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '4px' }}>Platform</div>
              <div style={{ fontSize: '16px', fontWeight: '600', color: '#111827' }}>{settings.platform || 'Unknown'}</div>
            </div>
            <div>
              <div style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '4px' }}>Last updated</div>
              <div style={{ fontSize: '16px', fontWeight: '600', color: '#111827' }}>
                {settings.lastUpdated ? new Date(settings.lastUpdated).toLocaleDateString() : 'Today'}
              </div>
            </div>
          </div>
          <div style={{ marginTop: '32px', display: 'flex', gap: '12px' }}>
            <button className="save-settings-btn" onClick={handleSaveSettings}>
              <i className="fas fa-save"></i> Save Settings
            </button>
            <button className="action-btn secondary" style={{ flex: 'none' }} onClick={handleCheckUpdates}>
              <i className="fas fa-download"></i> Check for Updates
            </button>
            <button className="action-btn secondary" style={{ flex: 'none' }} onClick={() => void handleCopyDebugBundle()}>
              <i className="fas fa-bug"></i> Copy Debug Bundle
            </button>
          </div>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="toast show" id="toast">
          {toast}
        </div>
      )}
    </div>
  );
};

export default SettingsView;