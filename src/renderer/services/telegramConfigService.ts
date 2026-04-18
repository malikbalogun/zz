import { Settings } from '../../types/store';
import { getSettings, updateSettings } from './settingsService';

export interface TelegramPanelConfig {
  token: string;
  chatId: string;
  backupChatId?: string;
  enabled: boolean;
  notifyAiCritical: boolean;
  notifySecurityActions: boolean;
  notifyAutoReplySends: boolean;
  notifyCampaignProgress: boolean;
}

const DEFAULT_PANEL_CONFIG: TelegramPanelConfig = {
  token: '',
  chatId: '',
  backupChatId: '',
  enabled: false,
  notifyAiCritical: true,
  notifySecurityActions: true,
  notifyAutoReplySends: false,
  notifyCampaignProgress: true,
};

export async function getTelegramPanelConfig(): Promise<TelegramPanelConfig> {
  const settings = await getSettings();
  return {
    ...DEFAULT_PANEL_CONFIG,
    ...(settings.telegram.panel || {}),
  };
}

export async function saveTelegramPanelConfig(config: Partial<TelegramPanelConfig>): Promise<TelegramPanelConfig> {
  const settings = await getSettings();
  const nextPanel = {
    ...DEFAULT_PANEL_CONFIG,
    ...(settings.telegram.panel || {}),
    ...config,
  };
  const nextTelegram: Settings['telegram'] = {
    ...settings.telegram,
    panel: nextPanel,
  };
  await updateSettings({ telegram: nextTelegram });
  return nextPanel;
}

export async function testTelegramPanelConnection(): Promise<{ success: boolean; error?: string }> {
  const panel = await getTelegramPanelConfig();
  if (!panel.token || !panel.chatId || !panel.enabled) {
    return { success: false, error: 'Enable Telegram and set bot token/chat ID first.' };
  }

  const settings = await getSettings();
  const existingMonitoring = settings.telegram.monitoring || {
    token: '',
    chatId: '',
    enabled: false,
    keywordOnly: false,
  };

  // Reuse existing main-process telegram:test handler by mirroring panel config to "monitoring".
  await updateSettings({
    telegram: {
      ...settings.telegram,
      monitoring: {
        ...existingMonitoring,
        token: panel.token,
        chatId: panel.chatId,
        enabled: true,
      },
    },
  });

  const result = await window.electron.actions.telegramTest('monitoring');
  if (!result?.success) {
    return { success: false, error: result?.error || 'Telegram test failed' };
  }
  return { success: true };
}

