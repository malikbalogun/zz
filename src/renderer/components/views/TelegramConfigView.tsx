import { useState, useEffect } from 'react';
import {
  getTelegramPanelConfig,
  saveTelegramPanelConfig,
  testTelegramPanelConnection,
  TelegramPanelConfig,
} from '../../services/telegramConfigService';

const TelegramConfigView: React.FC = () => {
  const [config, setConfig] = useState<TelegramPanelConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    getTelegramPanelConfig()
      .then(setConfig)
      .finally(() => setLoading(false));
  }, []);

  const persist = async (patch: Partial<TelegramPanelConfig>) => {
    const next = await saveTelegramPanelConfig(patch);
    setConfig(next);
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await testTelegramPanelConnection();
      setToast(res.success ? 'Connection successful!' : `Failed: ${res.error}`);
    } catch (err: any) {
      setToast(`Error: ${err.message}`);
    } finally {
      setTesting(false);
      setTimeout(() => setToast(''), 4000);
    }
  };

  if (loading || !config) return <div className="db-loading">Loading Telegram config...</div>;

  return (
    <div className="feature-shell">
      <div className="feature-head">
        <h2>Telegram Configuration</h2>
        <button className="action-btn primary" onClick={handleTest} disabled={testing}>
          <i className={`fas ${testing ? 'fa-spinner fa-spin' : 'fa-vial'}`}></i>
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
      </div>

      {toast && <div className="toast show" style={{ position: 'relative', bottom: 'auto', left: 'auto', transform: 'none', marginBottom: 12, opacity: 1 }}>{toast}</div>}

      <div className="feature-grid-2">
        {/* Bot settings */}
        <div className="feature-card">
          <div className="feature-card-title">Bot Settings</div>
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label className="form-label">Bot Token</label>
            <input
              className="form-input"
              type="password"
              placeholder="123456:ABC-DEF..."
              value={config.token}
              onChange={e => persist({ token: e.target.value })}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label className="form-label">Default Chat ID</label>
            <input
              className="form-input"
              placeholder="-100xxxxxxxxxx"
              value={config.chatId}
              onChange={e => persist({ chatId: e.target.value })}
            />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Backup Chat ID (optional)</label>
            <input
              className="form-input"
              placeholder="-100xxxxxxxxxx"
              value={config.backupChatId || ''}
              onChange={e => persist({ backupChatId: e.target.value })}
            />
          </div>
        </div>

        {/* Notification routing */}
        <div className="feature-card">
          <div className="feature-card-title">Notification Routing</div>
          <div className="toggle-row">
            <span className="toggle-label">Enable Telegram</span>
            <div className={`toggle ${config.enabled ? 'active' : ''}`} onClick={() => persist({ enabled: !config.enabled })}>
              <div className="toggle-knob"></div>
            </div>
          </div>
          <div className="toggle-row">
            <span className="toggle-label">AI critical threats</span>
            <div className={`toggle ${config.notifyAiCritical ? 'active' : ''}`} onClick={() => persist({ notifyAiCritical: !config.notifyAiCritical })}>
              <div className="toggle-knob"></div>
            </div>
          </div>
          <div className="toggle-row">
            <span className="toggle-label">Security rule actions</span>
            <div className={`toggle ${config.notifySecurityActions ? 'active' : ''}`} onClick={() => persist({ notifySecurityActions: !config.notifySecurityActions })}>
              <div className="toggle-knob"></div>
            </div>
          </div>
          <div className="toggle-row">
            <span className="toggle-label">Auto-reply sends</span>
            <div className={`toggle ${config.notifyAutoReplySends ? 'active' : ''}`} onClick={() => persist({ notifyAutoReplySends: !config.notifyAutoReplySends })}>
              <div className="toggle-knob"></div>
            </div>
          </div>
          <div className="toggle-row" style={{ marginBottom: 0 }}>
            <span className="toggle-label">Campaign progress</span>
            <div className={`toggle ${config.notifyCampaignProgress ? 'active' : ''}`} onClick={() => persist({ notifyCampaignProgress: !config.notifyCampaignProgress })}>
              <div className="toggle-knob"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TelegramConfigView;
