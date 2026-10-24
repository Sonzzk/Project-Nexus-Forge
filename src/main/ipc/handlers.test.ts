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

afterEach(removeTempDirs);

let pickedFolder: string | undefined;

async function setup() {
  const { db } = await openMigratedDb();
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
  registerHandlers(ipc, {
    logger,
    settings,
    activity,
    projects,
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
