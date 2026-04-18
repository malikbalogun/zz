import { useState, useEffect, useCallback } from 'react';
import type { UIAccount, Settings } from '../../../types/store';
import { getAccounts } from '../../services/accountService';
import { OutlookService } from '../../services/outlookService';
import { analyzeMessagesHeuristic, type HeuristicThreat } from '../../services/aiHeuristicScan';
import { analyzeMessagesOpenAI } from '../../services/aiOpenAiAnalysis';
import { getSettings, updateSettings } from '../../services/settingsService';

const AIAnalysisView: React.FC = () => {
  const [accounts, setAccounts] = useState<UIAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [threats, setThreats] = useState<HeuristicThreat[]>([]);
  const [selectedThreat, setSelectedThreat] = useState<HeuristicThreat | null>(null);
  const [analysisMode, setAnalysisMode] = useState<NonNullable<Settings['ai']>['analysisMode']>('heuristic');
  const [openaiApiKeyDraft, setOpenaiApiKeyDraft] = useState('');
  const [openaiModelDraft, setOpenaiModelDraft] = useState('gpt-4o-mini');
  const [useFullBodyDraft, setUseFullBodyDraft] = useState(false);
  const [aiSettingsLoaded, setAiSettingsLoaded] = useState(false);
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [filterLevel, setFilterLevel] = useState<string>('all');
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanNote, setScanNote] = useState('');

  useEffect(() => {
    (async () => {
      const accts = await getAccounts();
      const tokenOnes = accts.filter(a => a.auth?.type === 'token' && a.status === 'active');
      setAccounts(tokenOnes);
      if (tokenOnes.length && !selectedAccountId) {
        setSelectedAccountId(tokenOnes[0].id);
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      const ai = s.ai;
      setAnalysisMode(ai?.analysisMode ?? 'heuristic');
      setOpenaiApiKeyDraft(ai?.openaiApiKey ?? '');
      setOpenaiModelDraft(ai?.openaiModel?.trim() || 'gpt-4o-mini');
      setUseFullBodyDraft(!!ai?.useFullBodyForAnalysis);
      setAiSettingsLoaded(true);
    })();
  }, []);

  const persistAnalysisMode = async (mode: NonNullable<Settings['ai']>['analysisMode']) => {
    setAnalysisMode(mode);
    const cur = await getSettings();
    await updateSettings({
      ai: {
        ...cur.ai,
        analysisMode: mode,
      },
    });
  };

  const saveAiCredentials = async () => {
    const cur = await getSettings();
    await updateSettings({
      ai: {
        ...cur.ai,
        analysisMode: analysisMode ?? 'heuristic',
        openaiApiKey: openaiApiKeyDraft.trim(),
        openaiModel: openaiModelDraft.trim() || 'gpt-4o-mini',
        useFullBodyForAnalysis: useFullBodyDraft,
      },
    });
    setScanNote('AI settings saved.');
    setTimeout(() => setScanNote(''), 3000);
  };

  const runScan = useCallback(async () => {
    const account = accounts.find(a => a.id === selectedAccountId);
    if (!account) {
      setScanError('Select an account with a valid token.');
      return;
    }
    setLoading(true);
    setScanError('');
    setScanNote('');
    setSelectedThreat(null);
    try {
      const settings = await getSettings();
      const mode = settings.ai?.analysisMode ?? 'heuristic';
      const key = (settings.ai?.openaiApiKey || '').trim();
      const model = (settings.ai?.openaiModel || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
      const useFullBody = !!settings.ai?.useFullBodyForAnalysis;

      const folders = await OutlookService.listFolders(account);
      const inbox = folders.find(f => f.displayName.toLowerCase() === 'inbox') || folders[0];
      if (!inbox) {
        setThreats([]);
        setScanError('No folders returned for this mailbox.');
        return;
      }
      let messages = await OutlookService.fetchMessages(account, inbox.id, undefined, 40);
      if (useFullBody && messages.length > 0) {
        const toText = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const limit = Math.min(messages.length, 12);
        const clones = [...messages];
        const jobs = clones.slice(0, limit).map(async (m, idx) => {
          try {
            const details = await OutlookService.getMessageDetails(account, m.id);
            const txt = toText(details.body.content || '').slice(0, 1200);
            if (txt) {
              clones[idx] = { ...m, bodyPreview: `${m.bodyPreview || ''}\n${txt}`.trim() };
            }
          } catch {
            /* keep preview-only fallback */
          }
        });
        await Promise.all(jobs);
        messages = clones;
      }

      let rows: HeuristicThreat[];

      if (mode === 'openai' && key) {
        rows = await analyzeMessagesOpenAI(messages, account.email, key, model);
        setScanNote(
          rows.some(r => r.aiProvider === 'openai')
            ? `OpenAI ranked messages by scam susceptibility (subject + ${useFullBody ? 'full-body extract' : 'preview'}).`
            : 'OpenAI request failed or returned invalid JSON; showing local heuristics instead.'
        );
      } else {
        rows = analyzeMessagesHeuristic(messages, account.email).sort((a, b) => b.score - a.score);
        if (mode === 'openai' && !key) {
          setScanError('OpenAI is selected but no API key is saved. Enter your key below and click Save AI settings.');
        } else if (mode === 'anthropic') {
          setScanNote('Anthropic is not connected yet; using local heuristics.');
        }
      }

      setThreats(rows);
    } catch (e: any) {
      setScanError(e?.message || String(e));
      setThreats([]);
    } finally {
      setLoading(false);
    }
  }, [accounts, selectedAccountId]);

  useEffect(() => {
    if (autoAnalyze && selectedAccountId && accounts.length && aiSettingsLoaded) {
      void runScan();
    }
  }, [autoAnalyze, selectedAccountId, accounts.length, aiSettingsLoaded, runScan]);

  const criticalCount = threats.filter(t => t.threatLevel === 'critical').length;
  const highCount = threats.filter(t => t.threatLevel === 'high').length;
  const mediumCount = threats.filter(t => t.threatLevel === 'medium').length;
  const safeCount = threats.filter(t => t.threatLevel === 'safe' || t.threatLevel === 'low').length;

  const filteredThreats =
    filterLevel === 'all' ? threats : threats.filter(t => t.threatLevel === filterLevel);

  const getThreatColor = (level: string) => {
    const colors: Record<string, string> = {
      critical: '#dc2626',
      high: '#f59e0b',
      medium: '#f97316',
      low: '#3b82f6',
      safe: '#10b981',
    };
    return colors[level] || '#6b7280';
  };

  const getThreatBg = (level: string) => {
    const colors: Record<string, string> = {
      critical: '#fef2f2',
      high: '#fffbeb',
      medium: '#fff7ed',
      low: '#eff6ff',
      safe: '#f0fdf4',
    };
    return colors[level] || '#f9fafb';
  };

  const providerLabel = (t: HeuristicThreat) => {
    if (t.aiProvider === 'heuristic') return 'Heuristic (local rules)';
    return t.aiProvider === 'openai' ? 'OpenAI' : 'Anthropic';
  };

  return (
    <div id="aiAnalysisView">
      {scanError && (
        <div
          style={{
            background: '#fef2f2',
            border: '1px solid #fecaca',
            color: '#991b1b',
            padding: '12px 16px',
            borderRadius: 10,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          {scanError}
        </div>
      )}
      {scanNote && !scanError && (
        <div
          style={{
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            color: '#1e40af',
            padding: '12px 16px',
            borderRadius: 10,
            marginBottom: 16,
            fontSize: 13,
          }}
        >
          {scanNote}
        </div>
      )}

      <div style={{ marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <label className="form-label" style={{ margin: 0 }}>
          Mailbox
        </label>
        <select
          className="select"
          value={selectedAccountId}
          onChange={e => setSelectedAccountId(e.target.value)}
          style={{ minWidth: 260 }}
        >
          {accounts.length === 0 && <option value="">No token accounts</option>}
          {accounts.map(a => (
            <option key={a.id} value={a.id}>
              {a.email}
            </option>
          ))}
        </select>
        <button className="action-btn primary" onClick={() => void runScan()} disabled={loading || !selectedAccountId}>
          <i className="fas fa-sync"></i> {loading ? 'Scanning…' : 'Analyze inbox'}
        </button>
        <span style={{ fontSize: 12, color: '#6b7280' }}>
          Scans recent Inbox messages. Default uses preview text; optional setting fetches full-body extracts for deeper analysis.
        </span>
      </div>

      <div className="ai-overview-cards">
        <div className="ai-overview-card" style={{ borderLeftColor: '#dc2626' }}>
          <div className="ai-overview-icon" style={{ background: 'linear-gradient(135deg,#dc2626,#b91c1c)' }}>
            <i className="fas fa-exclamation-triangle"></i>
          </div>
          <div>
            <div className="ai-overview-val">{criticalCount}</div>
            <div className="ai-overview-label">Critical Threats</div>
          </div>
        </div>
        <div className="ai-overview-card" style={{ borderLeftColor: '#f59e0b' }}>
          <div className="ai-overview-icon" style={{ background: 'linear-gradient(135deg,#f59e0b,#d97706)' }}>
            <i className="fas fa-shield-alt"></i>
          </div>
          <div>
            <div className="ai-overview-val">{highCount + mediumCount}</div>
            <div className="ai-overview-label">Warnings</div>
          </div>
        </div>
        <div className="ai-overview-card" style={{ borderLeftColor: '#10b981' }}>
          <div className="ai-overview-icon" style={{ background: 'linear-gradient(135deg,#10b981,#059669)' }}>
            <i className="fas fa-check-circle"></i>
          </div>
          <div>
            <div className="ai-overview-val">{safeCount}</div>
            <div className="ai-overview-label">Safe / Low</div>
          </div>
        </div>
        <div className="ai-overview-card" style={{ borderLeftColor: '#3b82f6' }}>
          <div className="ai-overview-icon" style={{ background: 'linear-gradient(135deg,#3b82f6,#2563eb)' }}>
            <i className="fas fa-brain"></i>
          </div>
          <div>
            <div className="ai-overview-val">{threats.filter(t => t.analyzed).length}</div>
            <div className="ai-overview-label">Scanned</div>
          </div>
        </div>
        <div className="ai-overview-card" style={{ borderLeftColor: '#8b5cf6' }}>
          <div className="ai-overview-icon" style={{ background: 'linear-gradient(135deg,#8b5cf6,#7c3aed)' }}>
            <i className="fas fa-robot"></i>
          </div>
          <div>
            <div className="ai-overview-val">{autoAnalyze ? 'ON' : 'OFF'}</div>
            <div className="ai-overview-label">Auto-scan</div>
          </div>
        </div>
      </div>

      <div className="ai-toolbar">
        <div className="ai-toolbar-left">
          <div className="ai-filter-buttons">
            {['all', 'critical', 'high', 'medium', 'low', 'safe'].map(level => (
              <button
                key={level}
                className={`ai-filter-btn ${filterLevel === level ? 'active' : ''}`}
                onClick={() => setFilterLevel(level)}
                style={filterLevel === level ? { background: getThreatColor(level), color: 'white' } : {}}
              >
                {level.charAt(0).toUpperCase() + level.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="ai-toolbar-right">
          <button className="action-btn secondary" onClick={() => setShowSettings(!showSettings)}>
            <i className="fas fa-cog"></i> AI Settings
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="ai-settings-panel">
          <div className="ai-settings-grid">
            <div className="ai-setting-group">
              <label className="ai-setting-label">Analysis mode</label>
              <div className="ai-provider-toggle" style={{ flexWrap: 'wrap' }}>
                <button
                  className={`ai-provider-btn ${analysisMode === 'heuristic' ? 'active' : ''}`}
                  onClick={() => void persistAnalysisMode('heuristic')}
                  type="button"
                >
                  <i className="fas fa-sliders-h"></i> Heuristic
                </button>
                <button
                  className={`ai-provider-btn ${analysisMode === 'openai' ? 'active' : ''}`}
                  onClick={() => void persistAnalysisMode('openai')}
                  type="button"
                >
                  <i className="fas fa-robot"></i> OpenAI
                </button>
                <button
                  className={`ai-provider-btn ${analysisMode === 'anthropic' ? 'active' : ''}`}
                  onClick={() => void persistAnalysisMode('anthropic')}
                  type="button"
                >
                  <i className="fas fa-brain"></i> Anthropic
                </button>
              </div>
              <p style={{ fontSize: 12, color: '#6b7280', margin: '8px 0 0' }}>
                OpenAI sends subject, sender, and preview text to the API (via the app proxy). Anthropic is not wired yet.
              </p>
            </div>
            <div className="ai-setting-group">
              <label className="ai-setting-label">OpenAI API key</label>
              <input
                type="password"
                className="form-input"
                placeholder="sk-..."
                style={{ fontSize: '13px' }}
                value={openaiApiKeyDraft}
                onChange={e => setOpenaiApiKeyDraft(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="ai-setting-group">
              <label className="ai-setting-label">Model</label>
              <input
                type="text"
                className="form-input"
                placeholder="gpt-4o-mini"
                style={{ fontSize: '13px' }}
                value={openaiModelDraft}
                onChange={e => setOpenaiModelDraft(e.target.value)}
              />
            </div>
            <div className="ai-setting-group">
              <button className="action-btn primary" type="button" onClick={() => void saveAiCredentials()}>
                <i className="fas fa-save"></i> Save AI settings
              </button>
            </div>
            <div className="ai-setting-group">
              <label className="ai-setting-label">Auto-scan on account change</label>
              <div className="toggle-row" style={{ marginBottom: 0 }}>
                <span className="toggle-label" style={{ margin: 0 }}>
                  Re-run scan when mailbox changes
                </span>
                <div
                  className={`toggle ${autoAnalyze ? 'active' : ''}`}
                  onClick={() => setAutoAnalyze(!autoAnalyze)}
                >
                  <div className="toggle-knob"></div>
                </div>
              </div>
            </div>
            <div className="ai-setting-group">
              <label className="ai-setting-label">Message content depth</label>
              <div className="toggle-row" style={{ marginBottom: 0 }}>
                <span className="toggle-label" style={{ margin: 0 }}>
                  Append full-body text extract (first 12 messages)
                </span>
                <div
                  className={`toggle ${useFullBodyDraft ? 'active' : ''}`}
                  onClick={() => setUseFullBodyDraft(!useFullBodyDraft)}
                >
                  <div className="toggle-knob"></div>
                </div>
              </div>
              <p style={{ fontSize: 12, color: '#6b7280', margin: '8px 0 0' }}>
                OFF = subject + preview only (faster). ON = fetches each selected message body for richer analysis context. Takes effect after you click <strong>Save AI settings</strong>.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="ai-main-layout">
        <div className="ai-threat-list">
          {filteredThreats.length === 0 && !loading && (
            <div style={{ padding: 24, color: '#9ca3af', textAlign: 'center' }}>
              No messages scored yet. Choose an account and click &ldquo;Analyze inbox&rdquo;.
            </div>
          )}
          {filteredThreats.map(threat => (
            <div
              key={threat.id}
              className={`ai-threat-card ${selectedThreat?.id === threat.id ? 'selected' : ''}`}
              onClick={() => setSelectedThreat(threat)}
              style={{ borderLeftColor: getThreatColor(threat.threatLevel) }}
            >
              <div className="ai-threat-header">
                <span
                  className="ai-threat-level"
                  style={{ background: getThreatBg(threat.threatLevel), color: getThreatColor(threat.threatLevel) }}
                >
                  {threat.threatLevel === 'critical' && <i className="fas fa-exclamation-triangle"></i>}
                  {threat.threatLevel === 'high' && <i className="fas fa-exclamation-circle"></i>}
                  {threat.threatLevel === 'medium' && <i className="fas fa-exclamation"></i>}
                  {threat.threatLevel === 'low' && <i className="fas fa-info-circle"></i>}
                  {threat.threatLevel === 'safe' && <i className="fas fa-check-circle"></i>}{' '}
                  {threat.threatLevel.toUpperCase()}
                </span>
                {threat.scamSusceptibilityRank != null && threat.aiProvider === 'openai' && (
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: '#6b21a8',
                      background: '#f3e8ff',
                      padding: '2px 8px',
                      borderRadius: 6,
                    }}
                    title="Scam susceptibility rank in this batch (1 = worst)"
                  >
                    Rank #{threat.scamSusceptibilityRank}
                  </span>
                )}
                <span className="ai-threat-score" style={{ color: getThreatColor(threat.threatLevel) }}>
                  {threat.score}/100
                </span>
              </div>
              <div className="ai-threat-subject">{threat.subject}</div>
              <div className="ai-threat-from">
                <i className="fas fa-user"></i> {threat.from}
              </div>
              <div className="ai-threat-meta">
                <span>
                  <i className="fas fa-tag"></i> {threat.threatType}
                </span>
                <span>
                  <i className="fas fa-clock"></i> {new Date(threat.timestamp).toLocaleString()}
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="ai-detail-panel">
          {selectedThreat ? (
            <>
              <div className="ai-detail-header" style={{ background: getThreatBg(selectedThreat.threatLevel) }}>
                <div className="ai-detail-title-row">
                  <span
                    className="ai-detail-threat-badge"
                    style={{ background: getThreatColor(selectedThreat.threatLevel) }}
                  >
                    {selectedThreat.threatLevel.toUpperCase()} - Score: {selectedThreat.score}/100
                  </span>
                  <span className="ai-detail-provider">
                    <i className="fas fa-shield-alt"></i> {providerLabel(selectedThreat)}
                  </span>
                </div>
                <div className="ai-detail-subject">{selectedThreat.subject}</div>
                <div className="ai-detail-from-line">
                  From: <strong>{selectedThreat.from}</strong> &middot; Account: {selectedThreat.account}
                </div>
              </div>

              <div className="ai-detail-body">
                <div className="ai-detail-section">
                  <div className="ai-detail-section-title">
                    <i className="fas fa-brain"></i> Analysis
                  </div>
                  <div className="ai-detail-summary">{selectedThreat.summary}</div>
                </div>

                <div className="ai-detail-section">
                  <div className="ai-detail-section-title">
                    <i className="fas fa-flag"></i> Indicators
                  </div>
                  <div className="ai-detail-indicators">
                    {selectedThreat.indicators.map((ind, i) => (
                      <span
                        key={i}
                        className="ai-indicator-tag"
                        style={{
                          borderColor: getThreatColor(selectedThreat.threatLevel),
                          color: getThreatColor(selectedThreat.threatLevel),
                        }}
                      >
                        <i className="fas fa-exclamation-circle"></i> {ind}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="ai-detail-section">
                  <div className="ai-detail-section-title">
                    <i className="fas fa-chart-bar"></i> Risk score
                  </div>
                  <div className="ai-score-bar">
                    <div
                      className="ai-score-fill"
                      style={{
                        width: `${selectedThreat.score}%`,
                        background: getThreatColor(selectedThreat.threatLevel),
                      }}
                    />
                  </div>
                  <div className="ai-score-labels">
                    <span>Safe (0)</span>
                    <span>Critical (100)</span>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="ai-detail-empty">
              <i className="fas fa-shield-alt"></i>
              <h3>Inbox threat analysis</h3>
              <p>
                Select a message from the list. With OpenAI mode and a key, the model ranks scam susceptibility from subject
                and preview text; otherwise local heuristics apply.
              </p>
              <div className="ai-detail-empty-stats">
                <span>
                  <strong>{criticalCount}</strong> critical items in current scan
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AIAnalysisView;
