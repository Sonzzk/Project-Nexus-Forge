import { existsSync } from 'node:fs';
import { AppError } from '@shared/errors';
import type { AppInfo } from '@shared/ipc/contract';
import type { GitService } from '../git';
import type { ActivityLog } from '../logging';
import type { Logger } from '../logging';
import type { ProjectRegistry } from '../projects';
import type { ProviderService } from '../providers';
import type { AgentService, PlanningService, RunQueue, TaskService } from '../planning';
import type { ResourceReport } from '@shared/resources';
import type { AuditService, HandoffService, MemoryService, PackService } from '../scanning';
import type { StorageService } from '../storage';
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
  storage: StorageService;
  memory: MemoryService;
  packs: PackService;
  handoffs: HandoffService;
  tasks: TaskService;
  planning: PlanningService;
  agents: AgentService;
  providers: ProviderService;
  queue: RunQueue;
  /** A fresh resource snapshot with the local-inference verdict. */
  resources: () => Promise<ResourceReport>;
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

  ipc.handle('memory:overview', ({ projectId }) => services.memory.overview(projectId));
  ipc.handle('memory:read', ({ projectId, docType }) => services.memory.read(projectId, docType));
  ipc.handle('memory:preview', ({ projectId, docType, content }) => services.memory.preview(projectId, docType, content));
  ipc.handle('memory:save', ({ projectId, docType }) => services.memory.apply(projectId, docType));
  ipc.handle('memory:setStorage', ({ projectId, storage, docsDir }) => services.memory.setStorage(projectId, storage, docsDir));

  ipc.handle('packs:build', (request) => services.packs.build(request));
  ipc.handle('packs:save', ({ projectId, title }) => services.packs.save(projectId, title));
  ipc.handle('packs:list', ({ projectId }) => services.packs.list(projectId));
  ipc.handle('packs:get', ({ projectId, id }) => services.packs.get(projectId, id));
  ipc.handle('packs:refresh', ({ projectId, id }) => services.packs.refresh(projectId, id));
  ipc.handle('packs:remove', ({ projectId, id }) => {
    services.packs.remove(projectId, id);
    return { removed: true };
  });

  ipc.handle('handoffs:draft', ({ projectId }) => services.handoffs.draft(projectId));
  ipc.handle('handoffs:save', ({ projectId, fields }) => services.handoffs.save(projectId, fields));
  ipc.handle('handoffs:list', ({ projectId }) => services.handoffs.list(projectId));
  ipc.handle('handoffs:latest', ({ projectId }) => services.handoffs.latest(projectId));

  ipc.handle('tasks:list', ({ projectId }) => services.tasks.list(projectId));
  ipc.handle('tasks:create', (input) => services.tasks.create(input));
  ipc.handle('tasks:update', (patch) => services.tasks.update(patch));
  ipc.handle('tasks:remove', ({ id }) => {
    services.tasks.remove(id);
    return { removed: true };
  });
  ipc.handle('tasks:setStatus', ({ id, status }) => services.tasks.setStatus(id, status));
  ipc.handle('tasks:approvePlan', ({ id, approved }) => services.tasks.approvePlan(id, approved));
  ipc.handle('tasks:setDependencies', ({ id, dependsOn }) => services.tasks.setDependencies(id, dependsOn));
  ipc.handle('tasks:notes', ({ id }) => services.tasks.notes(id));
  ipc.handle('tasks:addNote', ({ id, text }) => services.tasks.addNote(id, text));
  ipc.handle('tasks:breakdown', (input) => services.tasks.breakdown(input));
  ipc.handle('tasks:recommend', ({ projectId }) => services.tasks.recommend(projectId));
  ipc.handle('tasks:portfolio', () => services.planning.portfolio());
  ipc.handle('milestones:list', ({ projectId }) => services.planning.milestones(projectId));
  ipc.handle('milestones:create', (input) => services.planning.createMilestone(input));
  ipc.handle('milestones:update', (patch) => services.planning.updateMilestone(patch));
  ipc.handle('milestones:remove', ({ id }) => {
    services.planning.removeMilestone(id);
    return { removed: true };
  });
  ipc.handle('milestones:snapshot', ({ id, label }) => services.planning.snapshot(id, label));
  ipc.handle('milestones:snapshots', ({ id }) => services.planning.snapshots(id));
  ipc.handle('risks:list', ({ projectId }) => services.planning.risks(projectId));
  ipc.handle('risks:create', (input) => services.planning.createRisk(input));
  ipc.handle('risks:update', (patch) => services.planning.updateRisk(patch));
  ipc.handle('risks:remove', ({ id }) => {
    services.planning.removeRisk(id);
    return { removed: true };
  });

  ipc.handle('agents:roles', () => services.agents.roles());
  ipc.handle('agents:preview', (request) => services.agents.preview(request));
  ipc.handle('agents:queue', (request) => services.agents.createWorkflow(request));
  ipc.handle('agents:runs', ({ taskId }) => services.agents.runs(taskId));
  ipc.handle('agents:prompt', ({ taskId, role }) => services.agents.prompt(taskId, role));
  ipc.handle('agents:record', ({ runId, outcome, note }) => services.queue.record(runId, outcome, note));

  ipc.handle('queue:view', ({ projectId }) => services.queue.view(projectId));
  ipc.handle('queue:route', ({ runId, choice }) => services.queue.route(runId, choice));
  ipc.handle('queue:start', ({ runId, choice }) => services.queue.start(runId, choice));
  ipc.handle('queue:cancel', ({ runId }) => services.queue.cancel(runId));
  ipc.handle('queue:setPriority', ({ runId, priority }) => services.queue.setPriority(runId, priority));
  ipc.handle('queue:retry', ({ runId, choice }) => services.queue.retry(runId, choice));
  ipc.handle('queue:releaseLock', ({ projectId }) => services.queue.releaseLock(projectId));
  ipc.handle('resources:check', () => services.resources());

  ipc.handle('providers:list', () => services.providers.list());
  ipc.handle('providers:check', ({ provider }) => services.providers.check(provider));
  ipc.handle('providers:models', ({ provider }) => services.providers.models(provider));
  ipc.handle('providers:warmUp', ({ model }) => services.providers.warmUp(model));
  ipc.handle('providers:pull', ({ model }) => services.providers.pull(model));
  ipc.handle('providers:cancel', () => services.providers.cancel());
  ipc.handle('providers:generate', ({ choice, prompt, purpose }) => services.providers.generate(choice, prompt, purpose));
  ipc.handle('providers:suggestSteps', (input) => services.providers.suggestSteps(input));
  ipc.handle('providers:draftDocument', (input) => services.providers.draftDocument(input));
  ipc.handle('providers:unload', ({ model }) => services.providers.unload(model));

  ipc.handle('storage:status', () => services.storage.status());
  ipc.handle('storage:backupNow', () => services.storage.backupNow());
  ipc.handle('storage:restore', ({ backupId }) => services.storage.restore(backupId));
  ipc.handle('storage:exportData', () => services.storage.exportData());
  ipc.handle('storage:previewImport', () => services.storage.previewImport());
  ipc.handle('storage:applyImport', ({ conflict }) => services.storage.applyImport(conflict));

  ipc.handle('git:summary', async ({ projectId }) => {
    const project = projects.get(projectId);
    if (project === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.');
    if (!existsSync(project.rootPath)) throw new AppError('NOT_FOUND', `The folder ${project.rootPath} could not be found.`, { hint: 'Reconnect the drive, then try again.' });
    return services.git.summary(project.rootPath, `git-${projectId}-${Date.now()}`);
  });
}
