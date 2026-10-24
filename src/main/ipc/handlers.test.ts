import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IpcResult } from '@shared/errors';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { removeTempDirs } from '../../../test/helpers/temp';
import { copyFixture } from '../../../test/helpers/tree';
import { createActivityLog } from '../logging/activity';
import { createRedactor } from '../logging/redactor';
import { createSettingsStore } from '../settings/store';
import { CHANNELS } from '@shared/ipc/channels';
import { createIpc, type InvokeEventLike } from './handle';
import { registerHandlers } from './handlers';
import { createRateLimiter } from './rate-limit';
import { createProjectRegistry } from '../projects';
import { createAgentService, createPlanningService, createTaskService } from '../planning';
import { createAuditService, createHandoffService, createMemoryService, createPackService } from '../scanning';
import { createStorageService, createTransfer, loadMigrations, type StorageUi } from '../storage';
import { createBackupService } from '../storage/backups';
import { projectTables } from '../projects';
import { settingsTable } from '../settings/export';
import { activityTable } from '../logging/export';
import { createGitService } from '../git';

afterEach(removeTempDirs);

let pickedFolder: string | undefined;
let revealed: string[] = [];
const uiCalls: string[] = [];
let uiAnswer = true;

async function setup() {
  const { db, dir } = await openMigratedDb();
  const logger = memoryLogger();
  const activity = createActivityLog({ db, redactor: createRedactor(), logger });
  const settings = createSettingsStore({ db, logger, activity });
  const listeners = new Map<string, (event: InvokeEventLike, ...args: unknown[]) => unknown>();
  const ipc = createIpc({
    ipcMain: { handle: (channel, listener) => void listeners.set(channel, listener) },
    logger,
    isTrustedUrl: () => true,
    isShuttingDown: () => false,
  });
  const projects = createProjectRegistry({ db, activity, logger });
  const redactor = createRedactor();
  const git = createGitService({ runner: { start: () => { throw new Error('no process'); } } as never, logger, locate: () => undefined });
  const audits = createAuditService({ db, projects, git, activity, logger, redactor, limits: () => ({ maxFiles: 20_000, budgetMs: 8000 }) });
  revealed = [];
  uiCalls.length = 0;
  const transfer = createTransfer({ db, appVersion: 'test', schemaVersion: () => loadMigrations().length });
  for (const table of [settingsTable, ...projectTables, activityTable]) transfer.register(table);
  const ui: StorageUi = {
    confirm: () => (uiCalls.push('confirm'), Promise.resolve(uiAnswer)),
    chooseExportFile: () => (uiCalls.push('save'), Promise.resolve(undefined)),
    chooseImportFile: () => (uiCalls.push('open'), Promise.resolve(undefined)),
    relaunch: () => void uiCalls.push('relaunch'),
  };
  const memory = createMemoryService({ db, projects, activity, confirm: () => (uiCalls.push('confirm'), Promise.resolve(uiAnswer)) });
  const packs = createPackService({ db, projects, memory, activity, limits: () => ({ maxFiles: 20_000, budgetMs: 8000 }) });
  const handoffs = createHandoffService({ db, projects, git, audits, activity });
  const tasks = createTaskService({ db, projects, activity, requirePlanApproval: () => false });
  const planning = createPlanningService({ db, projects, activity });
  const agents = createAgentService({ db, projects, tasks, activity });
  const storage = createStorageService({
    db,
    userDataDir: dir,
    backups: createBackupService({ db, dir: join(dir, 'backups'), logger }),
    transfer,
    activity,
    logger,
    ui,
    schemaVersion: () => loadMigrations().length,
    reloadSettings: () => settings.reload(),
  });
  registerHandlers(ipc, {
    logger,
    settings,
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
    git,
    reveal: (full) => void revealed.push(full),
    pickFolder: () => Promise.resolve(pickedFolder),
    appInfo: () => ({
      name: 'T',
      version: '1',
      platform: 'win32',
      electronVersion: '45',
      nodeVersion: '24',
      schemaVersion: 1,
      dataDir: '~\\d',
      logFile: '~\\l',
    }),
  });
  const call = (channel: string, input: unknown = {}) =>
    (listeners.get(channel) as (e: InvokeEventLike, ...a: unknown[]) => Promise<IpcResult<unknown>>)(
      { senderFrame: { url: 'x', parent: null } },
      input,
    );
  return { call, logger, activity, listeners };
}

describe('registerHandlers', () => {
  it('registers a handler for every channel in the registry and no other', async () => {
    const { listeners } = await setup();
    expect([...listeners.keys()].sort()).toEqual([...CHANNELS].sort());
  });

  it('settings:get returns defaults and settings:set stores a valid value', async () => {
    const { call } = await setup();
    expect(await call('settings:get')).toEqual({
      ok: true,
      value: expect.objectContaining({ 'ui.density': 'comfortable' }) as unknown,
    });
    expect(await call('settings:set', { key: 'ui.density', value: 'compact' })).toEqual({
      ok: true,
      value: expect.objectContaining({ 'ui.density': 'compact' }) as unknown,
    });
    expect(await call('settings:get')).toEqual({
      ok: true,
      value: expect.objectContaining({ 'ui.density': 'compact' }) as unknown,
    });
  });

  it('settings:set rejects a value that does not fit the key, with a hint, and stores nothing', async () => {
    const { call } = await setup();
    const result = await call('settings:set', { key: 'ui.density', value: 'huge' });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(JSON.stringify(result)).toContain('hint');
    expect(await call('settings:get')).toMatchObject({ ok: true, value: { 'ui.density': 'comfortable' } });
  });

  it('activity:list returns recorded events', async () => {
    const { call, activity } = await setup();
    activity.record({ kind: 'app.started', severity: 'info', summary: 'Started' });
    const result = await call('activity:list', { limit: 5 });
    expect(result).toMatchObject({ ok: true, value: [{ kind: 'app.started', summary: 'Started' }] });
  });

  it('app:reportRendererError logs the error and stops accepting after 20 a minute', async () => {
    const { call, logger } = await setup();
    const report = { kind: 'error', message: 'boom token=abc12345', stack: 'at x' };
    for (let i = 0; i < 20; i++)
      expect(await call('app:reportRendererError', report)).toEqual({ ok: true, value: { accepted: true } });
    expect(await call('app:reportRendererError', report)).toEqual({ ok: true, value: { accepted: false } });
    expect(
      logger.entries.filter((e) => e.mod === 'test.ipc.renderer' || e.msg === 'boom token=abc12345'),
    ).toHaveLength(20);
  });
});

describe('project channels', () => {
  type Result = { ok: true; value: { project: { id: string } } } | { ok: false; error: { code: string } };

  it('pickAndAdd registers the folder main chose, answers null when the picker is cancelled, and rejects duplicates', async () => {
    const { call } = await setup();
    pickedFolder = undefined;
    expect(await call('projects:pickAndAdd')).toEqual({ ok: true, value: { project: null } });
    pickedFolder = copyFixture('godot-game');
    const added = (await call('projects:pickAndAdd')) as Result;
    expect(added).toMatchObject({ ok: true, value: { project: { name: 'godot-game', type: 'godot' } } });
    expect(await call('projects:pickAndAdd')).toMatchObject({ ok: false, error: { code: 'ALREADY_EXISTS' } });
    expect(await call('projects:list')).toMatchObject({ ok: true, value: [{ name: 'godot-game' }] });
  });

  it('refuses a request that tries to pass a path', async () => {
    const { call } = await setup();
    expect(await call('projects:pickAndAdd', { path: 'C:\\Windows' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(await call('projects:update', { id: 'x', rootPath: 'C:\\Windows' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(await call('projects:update', { id: 'x', typeOverride: 'spaceship' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
  });

  it('updates, re-detects and removes, and unselects a removed project', async () => {
    const { call } = await setup();
    pickedFolder = copyFixture('vite-web');
    const added = (await call('projects:pickAndAdd')) as Result;
    if (!added.ok) throw new Error('add failed');
    const id = added.value.project.id;
    await call('settings:set', { key: 'projects.selectedId', value: id });

    expect(
      await call('projects:update', { id, name: 'Web game', tags: ['web'], status: 'paused' }),
    ).toMatchObject({ ok: true, value: { name: 'Web game', tags: ['web'], status: 'paused' } });
    expect(await call('projects:redetect', { id })).toMatchObject({ ok: true, value: { type: 'web-vite' } });
    expect(await call('projects:remove', { id })).toEqual({ ok: true, value: { removed: true } });
    expect(await call('projects:list')).toEqual({ ok: true, value: [] });
    expect(await call('settings:get')).toMatchObject({ ok: true, value: { 'projects.selectedId': null } });
    expect(await call('projects:remove', { id })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});
describe('audit channels', () => {
  async function withProject() {
    const env = await setup();
    pickedFolder = copyFixture('audit-godot');
    const added = (await env.call('projects:pickAndAdd')) as { ok: true; value: { project: { id: string; rootPath: string } } };
    return { ...env, id: added.value.project.id, root: added.value.project.rootPath };
  }

  it('runs an audit, returns the stored report as latest, lists it and fetches it by id', async () => {
    const { call, id } = await withProject();
    expect(await call('audit:latest', { projectId: id })).toEqual({ ok: true, value: null });
    const run = (await call('audit:run', { projectId: id })) as { ok: true; value: { id: string; sections: unknown[] } };
    expect(run).toMatchObject({ ok: true, value: { projectId: id } });
    expect(run.value.sections).toHaveLength(13);
    expect(await call('audit:latest', { projectId: id })).toEqual(run);
    expect(await call('audit:list', { projectId: id })).toMatchObject({ ok: true, value: [{ id: run.value.id }] });
    expect(await call('audit:get', { projectId: id, auditId: run.value.id })).toEqual(run);
    expect(await call('audit:run', { projectId: 'nope' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('git:summary answers for a project even when Git is not installed', async () => {
    const { call, id } = await withProject();
    expect(await call('git:summary', { projectId: id })).toMatchObject({ ok: true, value: { available: false, isRepository: false } });
    expect(await call('git:summary', { projectId: 'nope' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('reveals only files inside the project; a path that leaves it or does not exist is refused and nothing is shown', async () => {
    const { call, id, root } = await withProject();
    expect(await call('audit:reveal', { projectId: id, relativePath: 'scripts/player.gd' })).toEqual({ ok: true, value: { revealed: true } });
    expect(revealed).toHaveLength(1);
    expect(revealed[0]?.toLowerCase()).toContain('player.gd');
    for (const bad of ['../outside.txt', 'C:\\Windows\\win.ini', '\\\\server\\share']) {
      expect(await call('audit:reveal', { projectId: id, relativePath: bad })).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_PROJECT' } });
    }
    expect(await call('audit:reveal', { projectId: id, relativePath: 'missing.txt' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await call('audit:reveal', { projectId: id, relativePath: 'x', absolute: root })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(revealed).toHaveLength(1);
  });
});

describe('memory, pack and handoff channels', () => {
  async function withProject() {
    const env = await setup();
    pickedFolder = copyFixture('audit-godot');
    const added = (await env.call('projects:pickAndAdd')) as { ok: true; value: { project: { id: string } } };
    return { ...env, id: added.value.project.id };
  }

  it('memory: overview, preview and save in the app database; saving needs the preview first', async () => {
    const { call, id } = await withProject();
    expect(await call('memory:overview', { projectId: id })).toMatchObject({ ok: true, value: { storage: 'app', proposal: [{ type: 'PROJECT_CONTEXT' }, { type: 'DECISIONS' }, { type: 'SESSION_HANDOFF' }] } });
    expect(await call('memory:save', { projectId: id, docType: 'DECISIONS' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await call('memory:preview', { projectId: id, docType: 'DECISIONS', content: '# Decisions\n' })).toMatchObject({ ok: true, value: { isNew: true } });
    expect(await call('memory:save', { projectId: id, docType: 'DECISIONS' })).toEqual({ ok: true, value: { written: true, location: 'App database' } });
    expect(await call('memory:read', { projectId: id, docType: 'DECISIONS' })).toEqual({ ok: true, value: { content: '# Decisions\n', location: 'App database', exists: true } });
  });

  it('memory: refuses a folder that leaves the project, an unknown document type and a path field', async () => {
    const { call, id } = await withProject();
    expect(await call('memory:setStorage', { projectId: id, storage: 'docs-dir', docsDir: '..' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await call('memory:read', { projectId: id, docType: 'PASSWORDS' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await call('memory:preview', { projectId: id, docType: 'TASKS', content: 'x', path: 'C:\\x.md' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('writing into the project asks main to confirm first; a declined confirmation writes nothing', async () => {
    const { call, id } = await withProject();
    await call('memory:setStorage', { projectId: id, storage: 'project', docsDir: '' });
    await call('memory:preview', { projectId: id, docType: 'TASKS', content: '# Tasks\n' });
    uiAnswer = false;
    expect(await call('memory:save', { projectId: id, docType: 'TASKS' })).toEqual({ ok: true, value: { written: false, location: 'TASKS.md' } });
    expect(uiCalls).toEqual(['confirm']);
    uiAnswer = true;
  });

  it('packs: build, save, list, get, refresh and remove', async () => {
    const { call, id } = await withProject();
    const request = { projectId: id, task: 'change the player speed', budget: 4000, extraFiles: [], destination: 'Not sent anywhere yet' };
    const built = (await call('packs:build', request)) as { ok: true; value: { items: { path: string }[]; saved: boolean } };
    expect(built.value.items.map((i) => i.path)).toContain('scripts/player.gd');
    expect(built.value.saved).toBe(false);
    const saved = (await call('packs:save', { projectId: id, title: 'Speed' })) as { ok: true; value: { id: string } };
    expect(await call('packs:list', { projectId: id })).toMatchObject({ ok: true, value: [{ id: saved.value.id, title: 'Speed', stale: 0 }] });
    expect(await call('packs:get', { projectId: id, id: saved.value.id })).toMatchObject({ ok: true, value: { saved: true } });
    expect(await call('packs:refresh', { projectId: id, id: saved.value.id })).toMatchObject({ ok: true });
    expect(await call('packs:remove', { projectId: id, id: saved.value.id })).toEqual({ ok: true, value: { removed: true } });
    expect(await call('packs:get', { projectId: id, id: saved.value.id })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('packs: a hand-picked path outside the project and an oversized budget are refused', async () => {
    const { call, id } = await withProject();
    const base = { projectId: id, task: 'x y z', budget: 4000, extraFiles: [], destination: '' };
    expect(await call('packs:build', { ...base, extraFiles: ['../outside.txt'] })).toMatchObject({ ok: false, error: { code: 'PATH_OUTSIDE_PROJECT' } });
    expect(await call('packs:build', { ...base, budget: 10_000_000 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await call('packs:build', { ...base, cwd: 'C:\\' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });

  it('handoffs: draft, save, list and latest', async () => {
    const { call, id } = await withProject();
    expect(await call('handoffs:latest', { projectId: id })).toEqual({ ok: true, value: null });
    expect(await call('handoffs:draft', { projectId: id })).toMatchObject({ ok: true, value: { requested: '', nextTask: '' } });
    const fields = { requested: 'Add jump', changed: 'player.gd', verified: 'ran it', unfinished: 'none', risks: 'none', files: 'player.gd', nextTask: 'tune' };
    const saved = (await call('handoffs:save', { projectId: id, fields })) as { ok: true; value: { id: string } };
    expect(await call('handoffs:latest', { projectId: id })).toMatchObject({ ok: true, value: { id: saved.value.id, nextTask: 'tune' } });
    expect(await call('handoffs:list', { projectId: id })).toMatchObject({ ok: true, value: [{ id: saved.value.id }] });
    expect(await call('handoffs:save', { projectId: id, fields: { ...fields, extra: 'x' } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});

describe('task, milestone and register channels', () => {
  async function withProject() {
    const env = await setup();
    pickedFolder = copyFixture('audit-godot');
    const added = (await env.call('projects:pickAndAdd')) as { ok: true; value: { project: { id: string } } };
    return { ...env, id: added.value.project.id };
  }
  type Task = { id: string; status: string; allowedNext: string[] };

  it('creates a task, moves it only along valid steps, and says why a bad move is refused', async () => {
    const { call, id } = await withProject();
    const created = (await call('tasks:create', { projectId: id, title: 'Add jumping', priority: 'high', acceptance: ['Jump is tunable'] })) as { ok: true; value: Task };
    expect(created).toMatchObject({ ok: true, value: { status: 'inbox', allowedNext: ['planned', 'cancelled'] } });
    expect(await call('tasks:setStatus', { id: created.value.id, status: 'done' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: 'A task cannot go from Inbox to Done.' } });
    expect(await call('tasks:setStatus', { id: created.value.id, status: 'planned' })).toMatchObject({ ok: true, value: { status: 'planned' } });
    expect(await call('tasks:list', { projectId: id })).toMatchObject({ ok: true, value: [{ title: 'Add jumping', acceptance: ['Jump is tunable'] }] });
  });

  it('refuses unknown fields, paths that leave the project, and statuses that do not exist', async () => {
    const { call, id } = await withProject();
    expect(await call('tasks:create', { projectId: id, title: 'x', cwd: 'C:\\' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await call('tasks:create', { projectId: id, title: 'x', files: ['..\\..\\secret.txt'] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await call('tasks:setStatus', { id: 'x', status: 'finished' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await call('tasks:list', { projectId: 'nope' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('rejects a dependency loop and recommends a ready task with its reasons', async () => {
    const { call, id } = await withProject();
    const make = async (title: string) => ((await call('tasks:create', { projectId: id, title })) as { ok: true; value: Task }).value;
    const a = await make('A');
    const b = await make('B');
    await call('tasks:setDependencies', { id: b.id, dependsOn: [a.id] });
    expect(await call('tasks:setDependencies', { id: a.id, dependsOn: [b.id] })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await call('tasks:setStatus', { id: a.id, status: 'planned' });
    await call('tasks:setStatus', { id: a.id, status: 'ready' });
    expect(await call('tasks:recommend', { projectId: id })).toMatchObject({ ok: true, value: { items: [{ task: { title: 'A' }, reasons: expect.arrayContaining(['unblocks 1 other task']) as unknown }] } });
  });

  it('milestones with progress from stored tasks, snapshots, the register and the portfolio', async () => {
    const { call, id } = await withProject();
    const m = (await call('milestones:create', { projectId: id, title: 'Prototype', scopeTier: 'prototype', status: 'active' })) as { ok: true; value: { id: string; progress: { percent: number | null } } };
    expect(m.value.progress.percent).toBeNull();
    await call('tasks:create', { projectId: id, title: 'T', milestoneId: m.value.id });
    expect(await call('milestones:snapshot', { id: m.value.id, label: 'Start' })).toMatchObject({ ok: true, value: { label: 'Start', progress: { total: 1, done: 0, percent: 0 } } });
    expect(await call('milestones:snapshots', { id: m.value.id })).toMatchObject({ ok: true, value: [{ label: 'Start' }] });
    expect(await call('risks:create', { projectId: id, kind: 'bug', title: 'Crash', severity: 'high' })).toMatchObject({ ok: true, value: { status: 'open', severity: 'high' } });
    expect(await call('tasks:portfolio')).toMatchObject({ ok: true, value: [{ currentMilestone: 'Prototype', openBugs: 1, progress: { total: 1 } }] });
    expect(await call('milestones:remove', { id: m.value.id })).toEqual({ ok: true, value: { removed: true } });
  });

  it('breaks a feature down into a parent and chained steps', async () => {
    const { call, id } = await withProject();
    const made = (await call('tasks:breakdown', { projectId: id, title: 'Crouch', description: '', milestoneId: null, chain: true, steps: [{ title: 'Input', acceptance: ['C works'] }, { title: 'Camera', acceptance: [] }] })) as { ok: true; value: { title: string; dependsOn: string[]; id: string }[] };
    expect(made.value.map((t) => t.title)).toEqual(['Crouch', 'Input', 'Camera']);
    expect(made.value[2]?.dependsOn).toEqual([made.value[1]?.id]);
  });
});

describe('agent channels', () => {
  async function withTask() {
    const env = await setup();
    pickedFolder = copyFixture('audit-godot');
    const added = (await env.call('projects:pickAndAdd')) as { ok: true; value: { project: { id: string } } };
    const task = (await env.call('tasks:create', { projectId: added.value.project.id, title: 'Add jumping', provider: 'Claude Code' })) as { ok: true; value: { id: string } };
    return { ...env, taskId: task.value.id };
  }

  it('lists the roles, previews a workflow, queues it, and records an outcome by hand', async () => {
    const { call, taskId } = await withTask();
    expect(await call('agents:roles')).toMatchObject({ ok: true, value: [{ id: 'planner', writeCapable: false }, { id: 'implementer', writeCapable: true }, { id: 'reviewer' }, { id: 'qa' }, { id: 'docs' }, { id: 'assets' }] });
    const request = { taskId, workflow: 'implement', includeReviewer: false, includeQa: false };
    expect(await call('agents:preview', request)).toMatchObject({ ok: true, value: { launchUnavailable: true, steps: [{ role: 'planner', provider: 'Claude Code' }, { kind: 'approval' }, { role: 'implementer', blockedBy: expect.stringContaining('approved plan') as unknown }, { role: 'reviewer', included: false }, { role: 'qa', included: false }] } });
    const queued = (await call('agents:queue', request)) as { ok: true; value: { id: string; role: string; state: string }[] };
    expect(queued.value.map((r) => [r.role, r.state])).toEqual([['planner', 'queued'], ['implementer', 'queued']]);
    expect(await call('agents:queue', request)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(await call('agents:record', { runId: queued.value[0]?.id, outcome: 'completed', note: 'done by hand' })).toMatchObject({ ok: true, value: { state: 'completed' } });
    expect(await call('agents:runs', { taskId })).toMatchObject({ ok: true, value: [{ state: 'completed' }, { state: 'queued' }] });
  });

  it('cannot be asked to start a run: there is no channel that moves a run to running, and bad input is refused', async () => {
    const { call, taskId } = await withTask();
    const queued = (await call('agents:queue', { taskId, workflow: 'plan', includeReviewer: false, includeQa: false })) as { ok: true; value: { id: string }[] };
    const runId = queued.value[0]?.id;
    expect(await call('agents:record', { runId, outcome: 'running', note: '' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await call('agents:record', { runId, outcome: 'planning', note: '' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await call('agents:preview', { taskId, workflow: 'implement', includeReviewer: false, includeQa: false, provider: 'x' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await call('agents:preview', { taskId, workflow: 'run-everything', includeReviewer: true, includeQa: true })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await call('agents:prompt', { taskId, role: 'root' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await call('agents:prompt', { taskId, role: 'reviewer' })).toMatchObject({ ok: true, value: { writeCapable: false } });
  });
});

describe('storage channels', () => {
  it('backs up now, lists the backup by file name, and restores only after the native confirmation', async () => {
    const { call } = await setup();
    const made = (await call('storage:backupNow')) as { ok: true; value: { id: string; reason: string } };
    expect(made).toMatchObject({ ok: true, value: { reason: 'manual', id: expect.stringMatching(/^gdcc-.*-manual\.db$/) as unknown } });
    expect(await call('storage:status')).toMatchObject({ ok: true, value: { schemaVersion: loadMigrations().length, backups: [{ id: made.value.id }] } });

    uiAnswer = false;
    expect(await call('storage:restore', { backupId: made.value.id })).toEqual({ ok: true, value: { staged: false } });
    expect(uiCalls).toEqual(['confirm']);
    uiAnswer = true;
    expect(await call('storage:restore', { backupId: made.value.id })).toEqual({ ok: true, value: { staged: true } });
    expect(uiCalls).toEqual(['confirm', 'confirm', 'relaunch']);
  });

  it('never accepts a path, and names that are not backups are refused before anything is asked', async () => {
    const { call } = await setup();
    for (const backupId of ['C:\\Windows\\win.ini', '..\\data\\gdcc.db', 'gdcc.db'])
      expect(await call('storage:restore', { backupId })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await call('storage:restore', { backupId: 'x', path: 'C:\\x' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await call('storage:applyImport', { conflict: 'delete-everything' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(uiCalls).toEqual([]);
  });

  it('export and import ask main to open the native dialogs; a cancelled dialog changes nothing', async () => {
    const { call } = await setup();
    expect(await call('storage:exportData')).toMatchObject({ ok: true, value: { saved: false } });
    expect(await call('storage:previewImport')).toMatchObject({ ok: true, value: { staged: false, tables: [] } });
    expect(await call('storage:applyImport', { conflict: 'skip' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(uiCalls).toEqual(['save', 'open']);
  });
});

describe('createRateLimiter', () => {
  it('allows max calls per window and frees a slot as old calls age out', () => {
    let now = 0;
    const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => now });
    expect([limiter.tryTake(), limiter.tryTake(), limiter.tryTake()]).toEqual([true, true, false]);
    now = 999;
    expect(limiter.tryTake()).toBe(false);
    now = 1000;
    expect(limiter.tryTake()).toBe(true);
  });
});
