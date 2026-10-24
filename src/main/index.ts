import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { AppError } from '@shared/errors';
import type { AppInfo } from '@shared/ipc/contract';
import { installCrashHandlers } from './app/crash';
import { isAllowedUrl } from './app/navigation';
import { registerAppScheme, rendererRootFor, serveRenderer } from './app/protocol';
import { isRecoverable, runStartupRecovery } from './app/recovery';
import { createShutdownCoordinator } from './app/shutdown';
import { createMainWindow, installSecurityGuards, rendererDevServerUrl } from './app/window';
import { createGitService } from './git';
import { createEmitter, createIpc, registerHandlers } from './ipc';
import { activityTable, createActivityLog, type ActivityLog } from './logging';
import { createLogger } from './logging';
import { createRedactor } from './logging';
import { createProcessRunStore, createProcessRunner } from './process';
import { createProjectRegistry, projectTables } from './projects';
import { createClaudeCodeAdapter, createCodexAdapter, createOllamaAdapter, createProviderService, locateProgram, sandboxPath } from './providers';
import { agentTables, createAgentService, createPlanningService, createRunQueue, createTaskService, planningTables } from './planning';
import { createResourceMonitor } from './resources';
import { evaluateLocal, type ResourceReport } from '@shared/resources';
import { availabilityFrom } from '@shared/routing';
import { contextTables, createAuditService, createHandoffService, createMemoryService, createPackService } from './scanning';
import { createSettingsStore, settingsTable, type SettingsStore } from './settings';
import {
  applyPendingRestore,
  createBackupScheduler,
  createStorageService,
  createTransfer,
  loadMigrations,
  openAppDatabase,
  type StorageUi,
} from './storage';

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

// A test run can stop the app from starting itself again after a restore; a packaged app never reads this.
const skipRelaunch = !app.isPackaged && process.env['GDCC_TEST_NO_RELAUNCH'] === '1';
const relaunch = (): void => {
  if (!skipRelaunch) app.relaunch();
  app.quit();
};
const knownSchemaVersion = loadMigrations().length;

async function startServices(): Promise<void> {
  // A restore chosen in the last session is carried out now, before anything opens the database.
  const restored = applyPendingRestore({ userDataDir, knownSchemaVersion, logger: logger.child('restore') });
  const database = await openAppDatabase({
    userDataDir,
    appVersion: app.getVersion(),
    logger: logger.child('storage'),
    keepBackups: () => settings?.get('backup.keepCount') ?? 10,
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
  const transfer = createTransfer({ db, appVersion: app.getVersion(), schemaVersion: () => database.migrator.current() });
  for (const table of [settingsTable, ...projectTables, ...contextTables, ...planningTables, ...agentTables, activityTable]) transfer.register(table);
  const parent = (): BrowserWindow | undefined => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const ui: StorageUi = {
    confirm: async (options) => {
      const box = { type: 'warning' as const, buttons: [options.confirmLabel, 'Cancel'], defaultId: 1, cancelId: 1, noLink: true, title: options.title, message: options.message, ...(options.detail === undefined ? {} : { detail: options.detail }) };
      const window = parent();
      const result = window === undefined ? await dialog.showMessageBox(box) : await dialog.showMessageBox(window, box);
      return result.response === 0;
    },
    chooseExportFile: async (defaultName) => {
      const box = { title: 'Export app data', defaultPath: join(app.getPath('documents'), defaultName), filters: [{ name: 'JSON', extensions: ['json'] }] };
      const window = parent();
      const result = window === undefined ? await dialog.showSaveDialog(box) : await dialog.showSaveDialog(window, box);
      return result.canceled ? undefined : result.filePath;
    },
    chooseImportFile: async () => {
      const box = { title: 'Choose an export to import', properties: ['openFile' as const], filters: [{ name: 'JSON', extensions: ['json'] }] };
      const window = parent();
      const result = window === undefined ? await dialog.showOpenDialog(box) : await dialog.showOpenDialog(window, box);
      return result.canceled ? undefined : result.filePaths[0];
    },
    relaunch,
  };
  const storage = createStorageService({
    db,
    userDataDir,
    backups: database.backups,
    transfer,
    activity,
    logger: logger.child('data'),
    ui,
    schemaVersion: () => database.migrator.current(),
    reloadSettings: () => settingsStore.reload(),
  });
  const scheduler = createBackupScheduler({
    backups: database.backups,
    enabled: () => settingsStore.get('backup.scheduleEnabled'),
    intervalHours: () => settingsStore.get('backup.intervalHours'),
    logger: logger.child('backup'),
    onCreated: (info) =>
      void activity?.record({ kind: 'backup.created', severity: 'info', summary: 'Made a scheduled backup of the app data.', details: { sizeBytes: info.sizeBytes } }),
    onFailed: () => void activity?.record({ kind: 'backup.failed', severity: 'warning', summary: 'A scheduled backup could not be made. It will be tried again.' }),
  });
  scheduler.start();
  shutdown.register('backup-scheduler', 20, () => scheduler.stop());
  if (restored !== undefined)
    activity.record(
      'restoredFrom' in restored
        ? { kind: 'storage.restored', severity: 'warning', summary: `Restored the app data from ${restored.restoredFrom}. The previous data file was kept as ${restored.replacedFile ?? 'a renamed file'}.` }
        : { kind: 'storage.restore-failed', severity: 'error', summary: `A chosen restore was not applied: ${restored.failed}. The app data was left as it was.` },
    );

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
  const memory = createMemoryService({ db, projects, activity, confirm: (options) => ui.confirm(options) });
  const tasks = createTaskService({ db, projects, activity, requirePlanApproval: () => settingsStore.get('tasks.requirePlanApproval') });
  const packs = createPackService({
    db,
    projects,
    memory,
    activity,
    relatedTasks: (projectId, words) =>
      tasks
        .list(projectId)
        .filter((t) => t.status !== 'done' && t.status !== 'cancelled' && words.some((w) => `${t.title} ${t.description}`.toLowerCase().includes(w)))
        .slice(0, 8)
        .map((t) => `- ${t.title} (${t.status})${t.acceptance.length > 0 ? `: ${t.acceptance.join('; ')}` : ''}`)
        .join('\n'),
    limits: () => ({
      maxFiles: settingsStore.get('audit.maxFiles'),
      budgetMs: settingsStore.get('audit.timeBudgetSeconds') * 1000,
    }),
  });
  const handoffs = createHandoffService({ db, projects, git, audits, activity });
  const planning = createPlanningService({ db, projects, activity });
  const agents = createAgentService({ db, projects, tasks, activity });

  // AI providers. Each adapter finds its own program or address; credentials stay with the tools and are never read.
  const sandboxDir = sandboxPath(userDataDir);
  mkdirSync(sandboxDir, { recursive: true });
  const timeoutMs = (): number => settingsStore.get('providers.timeoutSeconds') * 1000;
  const cli = { runner, env: () => process.env, timeoutMs, sandboxDir: () => sandboxDir, logger: logger.child('providers') };
  const localPrograms = join(process.env['LOCALAPPDATA'] ?? app.getPath('home'), 'Programs');
  const providers = createProviderService({
    db,
    projects,
    activity,
    logger: logger.child('providers'),
    redactor,
    confirm: (options) => ui.confirm(options),
    progress: (progress) => emit('providers:progress', progress),
    ollamaEndpoint: () => settingsStore.get('providers.ollamaEndpoint'),
    env: () => process.env,
    sandboxDir: () => sandboxDir,
    adapters: {
      ollama: createOllamaAdapter({
        endpoint: () => settingsStore.get('providers.ollamaEndpoint'),
        allowRemote: () => settingsStore.get('providers.ollamaAllowRemote'),
        timeoutMs,
        contextLength: () => settingsStore.get('providers.ollamaContextLength'),
        keepAliveMinutes: () => settingsStore.get('inference.keepAliveMinutes'),
        locateProgram: () => locateProgram(['ollama'], [join(localPrograms, 'Ollama')]),
        logger: logger.child('ollama'),
      }),
      'claude-code': createClaudeCodeAdapter({ ...cli, locate: () => locateProgram(['claude'], [join(app.getPath('home'), '.local', 'bin')]) }),
      codex: createCodexAdapter({ ...cli, locate: () => locateProgram(['codex']) }),
    },
  });
  // Resources and the local-inference policy (spec §13). Probes run only when a snapshot is asked for.
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
  const monitor = createResourceMonitor({
    runner,
    locateNvidiaSmi: () => locateProgram(['nvidia-smi'], [join(systemRoot, 'System32'), join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI')]),
    tasklist: join(systemRoot, 'System32', 'tasklist.exe'),
    cwd: userDataDir,
    logger: logger.child('resources'),
  });
  const report = async (maxAgeMs = 0): Promise<ResourceReport> => {
    const snapshot = await monitor.snapshot(maxAgeMs);
    const verdict = evaluateLocal(snapshot, {
      mode: settingsStore.get('inference.mode'),
      minFreeVramMiB: settingsStore.get('inference.minFreeVramMiB'),
      minFreeRamMiB: settingsStore.get('inference.minFreeRamMiB'),
      holdForHeavyApps: settingsStore.get('inference.holdForHeavyApps'),
    });
    return { snapshot, verdict };
  };

  // The run queue: routes runs, starts them in order, owns the writer lock. Read-only until Step 15's permission gate exists.
  const queue = createRunQueue({
    db,
    agents,
    tasks,
    projects,
    activity,
    logger: logger.child('queue'),
    execute: (r) => providers.runAgent({ projectId: r.projectId, choice: { provider: r.provider, model: r.model }, prompt: r.prompt, note: r.note, signal: r.signal, onApproved: r.onApproved, ownerId: r.runId }),
    availability: async () => availabilityFrom(await providers.list()),
    providerBusy: (id) => providers.busy(id),
    routing: () => ({
      profile: settingsStore.get('routing.profile'),
      overrides: settingsStore.get('routing.roleOverrides'),
      localModel: settingsStore.get('routing.localModel'),
      maxAttempts: settingsStore.get('routing.maxAttempts'),
      apiKeySet: (process.env['ANTHROPIC_API_KEY'] ?? '') !== '',
    }),
    localPolicy: async () => (await report(5000)).verdict,
    recheckMs: () => settingsStore.get('inference.monitorIntervalSeconds') * 1000,
    confirm: (options) => ui.confirm(options),
    writesEnabled: false,
  });
  queue.recover();
  shutdown.register('agent-queue', 25, () => queue.shutdown());

  registerHandlers(ipc, {
    logger,
    settings: settingsStore,
    activity,
    projects,
    audits,
    storage,
    memory,
    packs,
    handoffs,
    tasks,
    planning,
    agents,
    providers,
    queue,
    resources: () => report(),
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
      // A damaged or newer database gets a choice of safe ways out; any other failure ends in the error box.
      if (isRecoverable(error)) {
        const restarting = await runStartupRecovery(error, {
          userDataDir,
          knownSchemaVersion,
          logFile: redactor.redact(logFile),
          logger: logger.child('recovery'),
          showBox: async (box) =>
            (
              await dialog.showMessageBox({
                type: 'error',
                title: box.title,
                message: box.message,
                detail: box.detail,
                buttons: box.buttons,
                defaultId: 0,
                cancelId: box.buttons.length - 1,
                noLink: true,
              })
            ).response,
          openFolder: (path) => void shell.openPath(path),
          relaunch,
        });
        if (!restarting) {
          quitting = true;
          app.exit(1);
        }
        return;
      }
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
