import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import './index.css';
import { getSettings, updateSettings } from './services/settingsService';
import { startBackgroundScheduler, stopBackgroundScheduler } from './services/backgroundScheduler';
import { getMonitoringAlerts } from './services/monitoringService';
import { getAccounts } from './services/accountService';
import { websocketManager } from './services/websocketService';
import { setOutlookMockMode } from './services/outlookService';


import watcherLogo from './assets/watcherlogo.png';

// Lazy-load each top-level view so Vite/Rollup splits them into their own
// chunks. Cuts the main entry chunk from ~550 kB to a much smaller core
// (only the active view + its deps load up-front; the rest stream in on
// first navigation). The Suspense boundary in renderView() shows a tiny
// loader while a view chunk is fetched.
const DashboardView = lazy(() => import('./components/views/DashboardView'));
const PanelsView = lazy(() => import('./components/views/PanelsView'));
const AccountsView = lazy(() => import('./components/views/AccountsView'));
const MonitoringView = lazy(() => import('./components/views/MonitoringView'));
const SettingsView = lazy(() => import('./components/views/SettingsView'));
const CentralInboxView = lazy(() => import('./components/views/CentralInboxView'));
const ContactsView = lazy(() => import('./components/views/ContactsView'));
const EmailComposerView = lazy(() => import('./components/views/EmailComposerView'));
const AIAnalysisView = lazy(() => import('./components/views/AIAnalysisView'));
const SecurityView = lazy(() => import('./components/views/SecurityView'));
const AutoReplyView = lazy(() => import('./components/views/AutoReplyView'));
const TelegramConfigView = lazy(() => import('./components/views/TelegramConfigView'));
const TaskManagerView = lazy(() => import('./components/views/TaskManagerView'));
const AnalyticsView = lazy(() => import('./components/views/AnalyticsView'));
const TemplateManagerView = lazy(() => import('./components/views/TemplateManagerView'));
const DomainIntelView = lazy(() => import('./components/views/DomainIntelView'));
const AuditLogView = lazy(() => import('./components/views/AuditLogView'));
const WebhooksView = lazy(() => import('./components/views/WebhooksView'));
const AccountHealthView = lazy(() => import('./components/views/AccountHealthView'));
const ReputationView = lazy(() => import('./components/views/ReputationView'));

import type { AddAccountInitialTab } from './components/AddAccountModal';

// View types
type View = 'dashboard' | 'panels' | 'accounts' | 'monitoring' | 'settings' | 'inbox' | 'contacts' | 'composer' | 'ai-analysis' | 'security' | 'auto-reply' | 'telegram' | 'tasks' | 'analytics' | 'templates' | 'domain-intel' | 'audit' | 'webhooks' | 'health' | 'reputation';

const NavItem: React.FC<{
  view: View;
  icon: string;
  label: string;
  active: View;
  onClick: (v: View) => void;
  badge?: number;
  badgeColor?: string;
  iconPrefix?: string;
}> = ({ view, icon, label, active, onClick, badge, badgeColor, iconPrefix = 'fas' }) => (
  <div
    className={`nav-item${active === view ? ' active' : ''}`}
    onClick={() => onClick(view)}
    data-view={view}
  >
    <div className="nav-icon"><i className={`${iconPrefix} ${icon}`}></i></div>
    <div className="nav-label">{label}</div>
    {badge !== undefined && badge > 0 && (
      <div className="badge" style={badgeColor ? { background: badgeColor } : undefined}>{badge}</div>
    )}
  </div>
);

const VIEW_TITLES: Record<View, string> = {
  dashboard: 'Dashboard',
  panels: 'Panels',
  accounts: 'Accounts',
  monitoring: 'Monitoring',

  settings: 'Settings',
  inbox: 'Central Inbox',
  contacts: 'Contacts',
  composer: 'Email Sender',
  'ai-analysis': 'AI Analysis',
  security: 'Security',
  'auto-reply': 'Auto Reply',
  telegram: 'Telegram',
  tasks: 'Tasks',
  analytics: 'Analytics',
  templates: 'Templates',
  'domain-intel': 'Domain Intel',
  audit: 'Audit Logs',
  webhooks: 'Webhooks / API',
  health: 'Account Health',
  reputation: 'Reputation',
};

const App = () => {
  const [activeView, setActiveView] = useState<View>('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [unreadAlerts, setUnreadAlerts] = useState(0);

  const [accountsCount, setAccountsCount] = useState(0);
  const [globalToast, setGlobalToast] = useState('');
  const [accountsOpenAddModalTab, setAccountsOpenAddModalTab] = useState<AddAccountInitialTab | null>(null);

  const clearAccountsOpenAddModalTab = useCallback(() => {
    setAccountsOpenAddModalTab(null);
  }, []);

  // Load saved state and settings on mount
  useEffect(() => {
    async function loadStateAndSettings() {
      // Load saved UI state
      try {
        const savedState = await window.electron.state.get();
        if (savedState.activeView && savedState.activeView !== activeView) {
          const view = savedState.activeView as string;
          if (view === 'search') {
            setActiveView('dashboard');
          } else {
            setActiveView(view as View);
          }
        }
        // Note: AccountsView now restores its own `activeTag` from the saved
        // state. `monitoringRunning` is reserved in the schema but no
        // renderer flow currently produces it, so there is nothing to restore.
      } catch (err) {
        console.warn('Failed to load saved state:', err);
      }
      // Load settings
      const settings = await getSettings();
      setDarkMode(settings.appearance.darkMode);
      setSidebarCollapsed(settings.appearance.sidebarCollapsed);
      // Initialise the OutlookService mock-mode flag from the freshly-loaded
      // settings so getOutlookService() can answer synchronously thereafter.
      setOutlookMockMode(
        !!(settings.debug?.useMockOutlookApi ?? settings.debug?.useMockGraphApi)
      );
      // Fetch alerts for sidebar badge
      try {
        const alerts = await getMonitoringAlerts();
        const unread = alerts.filter(a => !a.read).length;
        setUnreadAlerts(unread);
      } catch (err) {
        console.warn('Failed to load alerts:', err);
      }
      // Fetch accounts count for sidebar badge
      try {
        const accounts = await getAccounts();
        setAccountsCount(accounts.length);
      } catch (err) {
        console.warn('Failed to load accounts:', err);
      }
      setLoading(false);
      startBackgroundScheduler();
      websocketManager.startAll().catch(err => console.error('Failed to start WebSocket connections:', err));
    }
    loadStateAndSettings();
    return () => {
      stopBackgroundScheduler();
      websocketManager.stopAll();
    };
  }, []);

  // Persist activeView changes to state
  useEffect(() => {
    if (!loading) {
      window.electron.state.update({ activeView });
    }
  }, [activeView, loading]);





  // Apply dark mode class to body
  useEffect(() => {
    if (darkMode) {
      document.body.classList.add('dark');
    } else {
      document.body.classList.remove('dark');
    }
  }, [darkMode]);

  // Telegram send failures (monitoring / search)
  useEffect(() => {
    const onTelegramFailed = (e: Event) => {
      const ce = e as CustomEvent<{ scope?: string; error?: string }>;
      const msg = ce.detail?.error || 'Telegram send failed';
      const scope = ce.detail?.scope ? `${ce.detail.scope}: ` : '';
      setGlobalToast(`${scope}${msg}`);
      window.setTimeout(() => setGlobalToast(''), 8000);
    };
    window.addEventListener('watcher-telegram-failed', onTelegramFailed);
    return () => window.removeEventListener('watcher-telegram-failed', onTelegramFailed);
  }, []);

  useEffect(() => {
    const onOpenAddAccountModal = (e: Event) => {
      const ce = e as CustomEvent<{ tab?: AddAccountInitialTab }>;
      const t = ce.detail?.tab;
      const allowed: AddAccountInitialTab[] = ['panel', 'cookie', 'creds', 'device'];
      setAccountsOpenAddModalTab(t && allowed.includes(t) ? t : 'panel');
      setActiveView('accounts');
    };
    window.addEventListener('open-add-account-modal', onOpenAddAccountModal);
    return () => window.removeEventListener('open-add-account-modal', onOpenAddAccountModal);
  }, []);

  // Listen for accounts change events
  useEffect(() => {
    const handleAccountsChanged = async () => {
      try {
        const accountsData = await getAccounts();
        setAccountsCount(accountsData.length);
      } catch (err) {
        console.warn('Failed to refresh accounts:', err);
      }
    };
    window.addEventListener('accounts-changed', handleAccountsChanged);
    return () => {
      window.removeEventListener('accounts-changed', handleAccountsChanged);
    };
  }, []);

  // Sidebar Monitoring badge: refresh when alerts are cleared / updated elsewhere
  useEffect(() => {
    const refreshAlertBadge = async () => {
      try {
        const alerts = await getMonitoringAlerts();
        setUnreadAlerts(alerts.filter(a => !a.read).length);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('monitoring-alerts-changed', refreshAlertBadge);
    return () => window.removeEventListener('monitoring-alerts-changed', refreshAlertBadge);
  }, []);

  // Handle sidebar collapse
  const toggleSidebar = async () => {
    const newCollapsed = !sidebarCollapsed;
    setSidebarCollapsed(newCollapsed);
    const settings = await getSettings();
    await updateSettings({
      appearance: { ...settings.appearance, sidebarCollapsed: newCollapsed }
    });
  };

  // Handle view change
  const handleViewChange = (view: View) => {
    setActiveView(view);
  };

  // Toggle dark mode
  const toggleDarkMode = async () => {
    const newMode = !darkMode;
    setDarkMode(newMode);
    const settings = await getSettings();
    await updateSettings({
      appearance: { ...settings.appearance, darkMode: newMode }
    });
  };

  // Navigation that accepts string (for child components)
  const navigate = (view: string) => {
    setActiveView(view as View);
  };

  // Render the active view
  const renderView = () => {
    if (loading) {
      return <div className="loading">Loading settings...</div>;
    }
    switch (activeView) {
      case 'dashboard':
        return <DashboardView setActiveView={navigate} />;
      case 'panels':
        return <PanelsView />;
      case 'accounts':
        return (
          <AccountsView
            openAddAccountWithTab={accountsOpenAddModalTab}
            onOpenAddAccountConsumed={clearAccountsOpenAddModalTab}
          />
        );
      case 'monitoring':
        return <MonitoringView />;

      case 'settings':
        return <SettingsView />;
      case 'inbox':
        return <CentralInboxView />;
      case 'contacts':
        return <ContactsView />;
      case 'composer':
        return <EmailComposerView />;
      case 'ai-analysis':
        return <AIAnalysisView />;
      case 'security':
        return <SecurityView />;
      case 'auto-reply':
        return <AutoReplyView />;
      case 'telegram':
        return <TelegramConfigView />;
      case 'tasks':
        return <TaskManagerView />;
      case 'analytics':
        return <AnalyticsView />;
      case 'templates':
        return <TemplateManagerView />;
      case 'domain-intel':
        return <DomainIntelView />;
      case 'audit':
        return <AuditLogView />;
      case 'webhooks':
        return <WebhooksView />;
      case 'health':
        return <AccountHealthView />;
      case 'reputation':
        return <ReputationView />;
      default:
        return <DashboardView setActiveView={navigate} />;
    }
  };

  const sidebarClass = sidebarCollapsed ? 'sidebar collapsed' : 'sidebar';
  const collapseIcon = sidebarCollapsed ? 'fas fa-chevron-right' : 'fas fa-chevron-left';

  return (
    <div className="app">
      {globalToast && (
        <div
          className="toast show"
          role="alert"
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 100000,
            maxWidth: 'min(520px, 92vw)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
          }}
        >
          {globalToast}
        </div>
      )}
      {/* SIDEBAR */}
      <div className={sidebarClass} id="sidebar">
        <div className="logo">
          <div className="logo-icon">
            <img 
              src={watcherLogo}
              style={{ width: '36px', height: '36px' }} 
              alt="Watcher logo"
            />
          </div>
          <div className="logo-text">Watcher</div>
        </div>
        <div className="nav">
          {/* ── Core ── */}
          <NavItem view="dashboard" icon="fa-th-large" label="Dashboard" active={activeView} onClick={handleViewChange} />
          <NavItem view="panels" icon="fa-server" label="Panels" active={activeView} onClick={handleViewChange} />
          <NavItem view="accounts" icon="fa-users" label="Accounts" active={activeView} onClick={handleViewChange} badge={accountsCount} />


          <div className="nav-section-label">Email</div>
          <NavItem view="inbox" icon="fa-envelope-open-text" label="Central Inbox" active={activeView} onClick={handleViewChange} />
          <NavItem view="monitoring" icon="fa-bell" label="Monitoring" active={activeView} onClick={handleViewChange} badge={unreadAlerts} badgeColor="#10b981" />
          <NavItem view="contacts" icon="fa-address-book" label="Contacts" active={activeView} onClick={handleViewChange} />
          <NavItem view="composer" icon="fa-paper-plane" label="Email Sender" active={activeView} onClick={handleViewChange} />
          <NavItem view="templates" icon="fa-file-alt" label="Templates" active={activeView} onClick={handleViewChange} />

          <div className="nav-section-label">Intelligence</div>
          <NavItem view="ai-analysis" icon="fa-brain" label="AI Analysis" active={activeView} onClick={handleViewChange} />
          <NavItem view="security" icon="fa-shield-alt" label="Security" active={activeView} onClick={handleViewChange} />
          <NavItem view="auto-reply" icon="fa-reply" label="Auto Reply" active={activeView} onClick={handleViewChange} />
          <NavItem view="domain-intel" icon="fa-globe" label="Domain Intel" active={activeView} onClick={handleViewChange} />


          <div className="nav-section-label">Operations</div>
          <NavItem view="tasks" icon="fa-tasks" label="Tasks" active={activeView} onClick={handleViewChange} />



          <NavItem view="health" icon="fa-heartbeat" label="Account Health" active={activeView} onClick={handleViewChange} />
          <NavItem view="webhooks" icon="fa-plug" label="Webhooks/API" active={activeView} onClick={handleViewChange} />

          <div className="nav-divider"></div>

          <NavItem view="settings" icon="fa-cog" label="Settings" active={activeView} onClick={handleViewChange} />
        </div>
        <div className="sidebar-bottom">
          <div className="utility-item" id="darkModeToggle" onClick={toggleDarkMode}>
            <div className="nav-icon"><i className="fas fa-moon"></i></div>
            <div className="utility-label" id="darkModeLabel">
              {darkMode ? 'Light Mode' : 'Dark Mode'}
            </div>
          </div>
          <div className="collapse-btn" id="collapseBtn" onClick={toggleSidebar}>
            <i className={collapseIcon}></i>
          </div>
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div className="main">
        <div className="header">
          <h1 className="page-title" id="pageTitle">
            {VIEW_TITLES[activeView] || activeView}
          </h1>
          <div className="page-subtitle">
            <span className="green-dot"></span>
            <span id="pageSubtitle">All systems operational</span>
          </div>
        </div>
        <div className="content">
          <Suspense
            fallback={
              <div className="loading" style={{ padding: 24, color: '#9ca3af' }}>
                <i className="fas fa-spinner fa-spin" style={{ marginRight: 8 }} />
                Loading view…
              </div>
            }
          >
            {renderView()}
          </Suspense>
        </div>
      </div>
    </div>
  );
};

export default App;