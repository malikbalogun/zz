/**
 * Auto-updater wrapper around electron-updater.
 *
 * Wiring:
 *   - On app start (production builds only) we kick off a background
 *     checkForUpdates() and let electron-updater download + stage the
 *     update silently in the background.
 *   - When a download completes we notify the user via the renderer
 *     ('updater:downloaded' IPC) so the UI can show "Restart to apply"
 *     instead of jamming the install down their throat.
 *   - The existing 'updater:check' IPC (Settings → Check for updates)
 *     becomes a real synchronous check that returns the version we'd
 *     install (or null if up-to-date) and lets the user trigger a
 *     manual install via 'updater:install'.
 *
 * Release feed: GitHub Releases. The `publish` block in
 * package.json#build configures electron-updater to read
 * https://github.com/<owner>/<repo>/releases/latest/download/latest.yml
 * automatically — no env vars needed at install time.
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log/main';

let mainWindowGetter: (() => BrowserWindow | null) | null = null;
let lastCheckResult: {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  currentVersion: string;
  availableVersion?: string;
  error?: string;
  downloadProgressPercent?: number;
  releaseNotes?: string;
  checkedAt?: string;
} = {
  status: 'idle',
  currentVersion: app.getVersion(),
};

/** Send the current updater status to every renderer window. */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch { /* noop */ }
    }
  }
}

function notifyStatus(): void {
  broadcast('updater:status', lastCheckResult);
}

/** Wire electron-updater event handlers. Idempotent — safe to call once. */
export function initAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  mainWindowGetter = getMainWindow;

  // Pipe electron-updater logs into electron-log so they end up in the
  // user's log file (~/Library/Logs/<app>/main.log on macOS,
  // %USERPROFILE%\AppData\Roaming\<app>\logs\main.log on Windows).
  log.initialize();
  autoUpdater.logger = log;
  (autoUpdater.logger as any).transports = (autoUpdater.logger as any).transports || {};
  if ((autoUpdater.logger as any).transports?.file) {
    (autoUpdater.logger as any).transports.file.level = 'info';
  }

  // We handle the prompt + install ourselves so the user always sees a
  // "Restart to apply update" button instead of a silent forced install.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => {
    lastCheckResult = { ...lastCheckResult, status: 'checking', checkedAt: new Date().toISOString() };
    notifyStatus();
    log.info('[updater] checking-for-update');
  });

  autoUpdater.on('update-available', (info) => {
    lastCheckResult = {
      ...lastCheckResult,
      status: 'available',
      availableVersion: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
    };
    notifyStatus();
    log.info('[updater] update-available', info.version);
  });

  autoUpdater.on('update-not-available', () => {
    lastCheckResult = { ...lastCheckResult, status: 'not-available' };
    notifyStatus();
    log.info('[updater] update-not-available');
  });

  autoUpdater.on('download-progress', (progress) => {
    lastCheckResult = {
      ...lastCheckResult,
      status: 'downloading',
      downloadProgressPercent: Math.round(progress.percent),
    };
    notifyStatus();
  });

  autoUpdater.on('update-downloaded', (info) => {
    lastCheckResult = {
      ...lastCheckResult,
      status: 'downloaded',
      availableVersion: info.version,
      downloadProgressPercent: 100,
    };
    notifyStatus();
    log.info('[updater] update-downloaded', info.version);
    // Soft prompt — never force-restart, the user might be in the middle
    // of composing an email. They can restart whenever from the renderer
    // button or it'll auto-install on next quit anyway.
    const win = mainWindowGetter?.();
    if (win && !win.isDestroyed()) {
      void dialog
        .showMessageBox(win, {
          type: 'info',
          buttons: ['Restart now', 'Later'],
          defaultId: 0,
          cancelId: 1,
          title: 'Update ready',
          message: `Panel Manager ${info.version} is ready to install.`,
          detail: 'Restart now to apply, or it will install automatically next time you quit.',
        })
        .then((res) => {
          if (res.response === 0) {
            autoUpdater.quitAndInstall();
          }
        })
        .catch(() => {});
    }
  });

  autoUpdater.on('error', (err) => {
    const msg = err?.message || String(err);
    lastCheckResult = { ...lastCheckResult, status: 'error', error: msg };
    notifyStatus();
    log.error('[updater] error', msg);
  });

  // ---- IPC ----------------------------------------------------------------

  ipcMain.removeHandler('updater:check'); // replace the stub if it was registered
  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) {
      return {
        hasUpdate: false,
        message: 'Auto-update only runs in packaged builds (skipped in dev).',
        currentVersion: app.getVersion(),
      };
    }
    try {
      const res = await autoUpdater.checkForUpdates();
      const info = res?.updateInfo;
      const hasUpdate = !!info && info.version !== app.getVersion();
      return {
        hasUpdate,
        currentVersion: app.getVersion(),
        availableVersion: info?.version,
        message: hasUpdate ? `Update available: ${info?.version}` : 'You are on the latest version.',
      };
    } catch (err: any) {
      return {
        hasUpdate: false,
        currentVersion: app.getVersion(),
        message: `Update check failed: ${err?.message || String(err)}`,
      };
    }
  });

  ipcMain.handle('updater:status', () => lastCheckResult);

  ipcMain.handle('updater:install', () => {
    if (lastCheckResult.status !== 'downloaded') {
      return { success: false, error: 'No update has been downloaded yet.' };
    }
    autoUpdater.quitAndInstall();
    return { success: true };
  });
}

/**
 * Kick off a background update check. Should be called once on app start,
 * after the main window exists, in production builds only.
 */
export function scheduleStartupUpdateCheck(): void {
  if (!app.isPackaged) {
    log.info('[updater] dev build, skipping startup update check');
    return;
  }
  // Wait ~5s after launch so we don't compete with the user's first
  // interaction for network/CPU. Then check every 4 hours while the
  // app is running.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => log.warn('[updater] startup check failed', err?.message || err));
  }, 5000);
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => log.warn('[updater] periodic check failed', err?.message || err));
  }, 4 * 60 * 60 * 1000);
}
