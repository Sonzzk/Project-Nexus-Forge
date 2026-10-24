import { afterEach, describe, expect, it } from 'vitest';
import type { IpcResult } from '@shared/errors';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { removeTempDirs } from '../../../test/helpers/temp';
import { createActivityLog } from '../logging/activity';
import { createRedactor } from '../logging/redactor';
import { createSettingsStore } from '../settings/store';
import { CHANNELS } from '@shared/ipc/channels';
import { createIpc, type InvokeEventLike } from './handle';
import { registerHandlers } from './handlers';
import { createRateLimiter } from './rate-limit';

afterEach(removeTempDirs);

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
  registerHandlers(ipc, {
    logger,
    settings,
    activity,
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
      value: { 'logging.level': 'info', 'ui.density': 'comfortable' },
    });
    expect(await call('settings:set', { key: 'ui.density', value: 'compact' })).toEqual({
      ok: true,
      value: { 'logging.level': 'info', 'ui.density': 'compact' },
    });
    expect(await call('settings:get')).toEqual({
      ok: true,
      value: { 'logging.level': 'info', 'ui.density': 'compact' },
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
