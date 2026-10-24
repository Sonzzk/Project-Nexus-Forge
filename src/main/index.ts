import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { AppError } from '@shared/errors';
import type { AppInfo } from '@shared/ipc/contract';
import { installCrashHandlers } from './app/crash';
import { isAllowedUrl } from './app/navigation';
import { registerAppScheme, rendererRootFor, serveRenderer } from './app/protocol';
import { createShutdownCoordinator } from './app/shutdown';
import { createMainWindow, installSecurityGuards, rendererDevServerUrl } from './app/window';
import { createGitService } from './git';
import { createEmitter, createIpc, registerHandlers } from './ipc';
import { createActivityLog, type ActivityLog } from './logging';
import { createLogger } from './logging';
import { createRedactor } from './logging';
import { createProcessRunStore, createProcessRunner } from './process';
import { createProjectRegistry } from './projects';
import { createAuditService } from './scanning';
import { createSettingsStore, type SettingsStore } from './settings';
import { openAppDatabase } from './storage';

// Composition root: the only place that decides which implementation is used (ARCHITECTURE.md section 4).

// All of this must happen before `ready`.
app.enableSandbox();
registerAppScheme();
// The data folder never depends on the display name (D-024). Dev and test runs may redirect it; packaged builds may not.
const dataDirOverride = app.isPackaged ? undefined : process.env['GDCC_USER_DATA_DIR'];
const userDataDir = dataDirOverride ?? join(app.getPath('appData'), 'GameDevCommandCenter');
app.setPath('userData', userDataDir);

const redactor = createRedactor({ homeDir: app.getPath('home') });
let settings: SettingsStore | undefined;
let activity: ActivityLog | undefined;
const logFile = join(userDataDir, 'logs', 'main.log');
const logger = createLogger({
  dir: join(userDataDir, 'logs'),
  redactor,
  level: () => settings?.get('logging.level') ?? 'info',
});
const shutdown = createShutdownCoordinator({ logger });

installCrashHandlers({
  logger,
  activity: () => activity,
  processEvents: process,
  appEvents: app,
  onFatal: (error) =>
    dialog.showErrorBox(
      'GameDev Command Center hit an unexpected error',
      `${redactor.redact(error instanceof Error ? error.message : String(error))}\n\nDetails are in the log:\n${redactor.redact(logFile)}`,
    ),
});

// The first quit is deferred until the shutdown steps have run (stop work, cancel programs, flush the log, close the database).
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void shutdown.shutdown('quit').finally(() => app.quit());
});
shutdown.register('logger', 80, () => logger.flush());

async function startServices(): Promise<void> {
  const database = await openAppDatabase({
    userDataDir,
    appVersion: app.getVersion(),
    logger: logger.child('storage'),
  });
  const { db } = database;
  shutdown.register('database', 90, () => db.close());

  const emit = createEmitter(() => BrowserWindow.getAllWindows().map((window) => window.webContents));
  activity = createActivityLog({
    db,
    redactor,
    logger: logger.child('activity'),
    emit: (event) => emit('activity:appended', event),
  });
  const settingsStore = createSettingsStore({ db, logger: logger.child('settings'), activity });
  settings = settingsStore;

  const runStore = createProcessRunStore(db, redactor, logger);
  runStore.markStaleRunsLost();
  const runner = createProcessRunner({ logger, redactor, store: runStore });
  // Nothing in Step 4 starts a program yet; the runner is ready for the steps that do, and cleaned up on quit.
  shutdown.register('processes', 30, async () => {
    runner.stopAccepting();
    await runner.cancelAll('app quitting');
  });
  const stopActivity = activity;
  shutdown.register(
    'activity',
    50,
    () => void stopActivity.record({ kind: 'app.stopped', severity: 'info', summary: 'The app closed.' }),
  );

  const ipc = createIpc({
    ipcMain,
    logger,
    isTrustedUrl: (url) => isAllowedUrl(url, rendererDevServerUrl),
    isShuttingDown: () => shutdown.isShuttingDown,
  });
  const appInfo = (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    schemaVersion: database.migrator.current(),
    dataDir: redactor.redact(userDataDir),
    logFile: redactor.redact(logFile),
  });
  const projects = createProjectRegistry({
    db,
    activity,
    logger: logger.child('projects'),
    protectedDirs: [userDataDir],
  });
  // The only way a folder reaches the registry: a native dialog opened here, never a path from the page.
  const pickFolder = async (): Promise<string | undefined> => {
    const options = { title: 'Choose a project folder', properties: ['openDirectory' as const] };
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result =
      window === undefined
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(window, options);
    return result.canceled ? undefined : result.filePaths[0];
  };
  const git = createGitService({ runner, logger: logger.child('git') });
  const audits = createAuditService({
    db,
    projects,
    git,
    activity,
    logger: logger.child('audit'),
    redactor,
    limits: () => ({
      maxFiles: settingsStore.get('audit.maxFiles'),
      budgetMs: settingsStore.get('audit.timeBudgetSeconds') * 1000,
    }),
  });
  registerHandlers(ipc, {
    logger,
    settings: settingsStore,
    activity,
    projects,
    audits,
    git,
    reveal: (fullPath) => shell.showItemInFolder(fullPath),
    pickFolder,
    appInfo,
  });
  shutdown.register('ipc', 10, () => undefined); // `shutdown.isShuttingDown` already refuses new IPC calls

  activity.record({
    kind: 'app.started',
    severity: 'info',
    summary: `GameDev Command Center ${app.getVersion()} started.`,
    details: { schemaVersion: database.schemaVersion, migrated: database.report.from !== database.report.to },
  });
  logger.info('app started', {
    version: app.getVersion(),
    electron: process.versions.electron,
    schemaVersion: database.schemaVersion,
  });
}

/** A database that cannot be opened is never replaced or deleted: say what is wrong and what to do, then stop. */
function failStartup(error: unknown): void {
  const appError = error instanceof AppError ? error : undefined;
  logger.error('startup failed', { error });
  dialog.showErrorBox(
    'GameDev Command Center could not start',
    [
      appError?.message ?? 'Something went wrong while starting. Details are in the log.',
      appError?.hint,
      `Data folder: ${redactor.redact(userDataDir)}`,
      `Log: ${redactor.redact(logFile)}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
  quitting = true; // nothing to shut down gracefully
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window === undefined) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  void app.whenReady().then(async () => {
    try {
      // The default File/Edit/View/Window menu is for development; a packaged app has its own UI (KI-009).
      if (app.isPackaged) Menu.setApplicationMenu(null);
      installSecurityGuards();
      serveRenderer(rendererRootFor(__dirname));
      await startServices();
    } catch (error) {
      failStartup(error);
      return;
    }
    createMainWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
