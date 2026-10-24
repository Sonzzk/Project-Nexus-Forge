import type { AppInfo } from '@shared/ipc/contract';
import type { ActivityLog } from '../logging';
import type { Logger } from '../logging';
import type { ProjectRegistry } from '../projects';
import type { SettingsStore } from '../settings';
import type { Ipc } from './handle';
import { createRateLimiter } from './rate-limit';

export interface HandlerServices {
  logger: Logger;
  settings: SettingsStore;
  activity: ActivityLog;
  projects: ProjectRegistry;
  /** Opens the native folder picker; undefined when the user cancels. */
  pickFolder: () => Promise<string | undefined>;
  appInfo(): AppInfo;
}

/** Registers every channel in the registry. Each step adds its own handlers here (or beside this file) as it adds channels. */
export function registerHandlers(ipc: Ipc, services: HandlerServices): void {
  const { logger, settings, activity, projects } = services;
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
}
