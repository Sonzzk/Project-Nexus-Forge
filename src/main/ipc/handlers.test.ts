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
import { createAuditService } from '../scanning';
import { createStorageService, createTransfer, type StorageUi } from '../storage';
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
  const transfer = createTransfer({ db, appVersion: 'test', schemaVersion: () => 3 });
  for (const table of [settingsTable, ...projectTables, activityTable]) transfer.register(table);
  const ui: StorageUi = {
    confirm: () => (uiCalls.push('confirm'), Promise.resolve(uiAnswer)),
    chooseExportFile: () => (uiCalls.push('save'), Promise.resolve(undefined)),
    chooseImportFile: () => (uiCalls.push('open'), Promise.resolve(undefined)),
    relaunch: () => void uiCalls.push('relaunch'),
  };
  const storage = createStorageService({
    db,
    userDataDir: dir,
    backups: createBackupService({ db, dir: join(dir, 'backups'), logger }),
    transfer,
    activity,
    logger,
    ui,
    schemaVersion: () => 3,
    reloadSettings: () => settings.reload(),
  });
  registerHandlers(ipc, {
    logger,
    settings,
    activity,
    projects,
    audits,
    storage,
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

describe('storage channels', () => {
  it('backs up now, lists the backup by file name, and restores only after the native confirmation', async () => {
    const { call } = await setup();
    const made = (await call('storage:backupNow')) as { ok: true; value: { id: string; reason: string } };
    expect(made).toMatchObject({ ok: true, value: { reason: 'manual', id: expect.stringMatching(/^gdcc-.*-manual\.db$/) as unknown } });
    expect(await call('storage:status')).toMatchObject({ ok: true, value: { schemaVersion: 3, backups: [{ id: made.value.id }] } });

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
