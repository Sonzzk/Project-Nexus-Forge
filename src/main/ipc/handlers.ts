import { existsSync } from 'node:fs';
import { AppError } from '@shared/errors';
import type { AppInfo } from '@shared/ipc/contract';
import type { GitService } from '../git';
import type { ActivityLog } from '../logging';
import type { Logger } from '../logging';
import type { ProjectRegistry } from '../projects';
import type { AuditService } from '../scanning';
import { resolveInside } from '../security';
import type { SettingsStore } from '../settings';
import type { Ipc } from './handle';
import { createRateLimiter } from './rate-limit';

export interface HandlerServices {
  logger: Logger;
  settings: SettingsStore;
  activity: ActivityLog;
  projects: ProjectRegistry;
  audits: AuditService;
  git: GitService;
  /** Shows a file or folder in Windows Explorer. Only ever called with a path that `resolveInside` accepted. */
  reveal: (fullPath: string) => void;
  /** Opens the native folder picker; undefined when the user cancels. */
  pickFolder: () => Promise<string | undefined>;
  appInfo(): AppInfo;
}

/** Registers every channel in the registry. Each step adds its own handlers here (or beside this file) as it adds channels. */
export function registerHandlers(ipc: Ipc, services: HandlerServices): void {
  const { logger, settings, activity, projects, audits } = services;
  // Renderer errors are capped at 20 a minute so a render loop cannot flood the log (ARCHITECTURE.md section 11).
  const rendererErrors = createRateLimiter({ max: 20, windowMs: 60_000 });

  ipc.handle('app:getInfo', () => services.appInfo());

  ipc.handle('app:reportRendererError', (input) => {
    if (!rendererErrors.tryTake()) return { accepted: false };
    logger
      .child('renderer')
      .error(input.message, { kind: input.kind, stack: input.stack, source: input.source });
    return { accepted: true };
  });

  ipc.handle('settings:get', () => settings.all());

  ipc.handle('settings:set', ({ key, value }) => {
    settings.set(key, value);
    return settings.all();
  });

  ipc.handle('activity:list', (filter) => activity.list(filter));

  ipc.handle('projects:list', () => projects.list());

  ipc.handle('projects:pickAndAdd', async () => {
    const folder = await services.pickFolder();
    return { project: folder === undefined ? null : projects.add(folder) };
  });

  ipc.handle('projects:update', (patch) => projects.update(patch));

  ipc.handle('projects:redetect', ({ id }) => projects.redetect(id));

  ipc.handle('projects:remove', ({ id }) => {
    projects.remove(id);
    if (settings.get('projects.selectedId') === id) settings.set('projects.selectedId', null);
    return { removed: true };
  });

  ipc.handle('audit:run', ({ projectId }) => audits.run(projectId));
  ipc.handle('audit:latest', ({ projectId }) => audits.latest(projectId));
  ipc.handle('audit:list', ({ projectId }) => audits.list(projectId));
  ipc.handle('audit:get', ({ projectId, auditId }) => audits.get(projectId, auditId));

  ipc.handle('audit:reveal', ({ projectId, relativePath }) => {
    const project = projects.get(projectId);
    if (project === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.');
    const full = resolveInside(project.rootPath, relativePath); // refuses anything outside the project folder
    if (!existsSync(full)) throw new AppError('NOT_FOUND', 'That file no longer exists.', { hint: 'Run the audit again to refresh the report.' });
    services.reveal(full);
    return { revealed: true };
  });

  ipc.handle('git:summary', async ({ projectId }) => {
    const project = projects.get(projectId);
    if (project === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.');
    if (!existsSync(project.rootPath)) throw new AppError('NOT_FOUND', `The folder ${project.rootPath} could not be found.`, { hint: 'Reconnect the drive, then try again.' });
    return services.git.summary(project.rootPath, `git-${projectId}-${Date.now()}`);
  });
}
