import { describe, expect, it } from 'vitest';
import { SettingsSchema } from '@shared/settings';
import { AppError, INTERNAL_ERROR_MESSAGE, type IpcResult } from '@shared/errors';
import { memoryLogger } from '../../../test/helpers/logger';
import { createIpc, type InvokeEventLike, type IpcMainLike } from './handle';

const TRUSTED = 'app://renderer/index.html';
const trustedFrame = { url: TRUSTED, parent: null };

function setup(options: { shuttingDown?: boolean } = {}) {
  const listeners = new Map<string, (event: InvokeEventLike, ...args: unknown[]) => unknown>();
  const ipcMain: IpcMainLike = { handle: (channel, listener) => void listeners.set(channel, listener) };
  const logger = memoryLogger();
  const ipc = createIpc({
    ipcMain,
    logger,
    isTrustedUrl: (url) => url.startsWith('app://renderer/'),
    isShuttingDown: () => options.shuttingDown ?? false,
    newRequestId: () => 'req-1',
  });
  const call = (
    channel: string,
    args: unknown[],
    frame: InvokeEventLike['senderFrame'] = trustedFrame,
  ): Promise<IpcResult<unknown>> => {
    const listener = listeners.get(channel);
    if (listener === undefined) throw new Error(`no handler for ${channel}`);
    return listener({ senderFrame: frame }, ...args) as Promise<IpcResult<unknown>>;
  };
  return { ipc, call, logger, listeners };
}

const errorOf = (result: IpcResult<unknown>) => {
  if (result.ok) throw new Error('expected an error result');
  return result.error;
};

describe('createIpc', () => {
  it('runs the handler with the parsed request and answers with the validated response', async () => {
    const { ipc, call } = setup();
    ipc.handle('activity:list', (input, context) => {
      expect(input).toEqual({ limit: 50 }); // the schema's default was applied
      expect(context).toEqual({ requestId: 'req-1', senderUrl: TRUSTED });
      return [];
    });
    expect(await call('activity:list', [{}])).toEqual({ ok: true, value: [] });
  });

  it.each([
    ['unknown field (strict schema)', [{ limit: 5, path: 'C:\\Windows' }]],
    ['wrong type', [{ limit: 'five' }]],
    ['out of range', [{ limit: 100000 }]],
    ['too many kinds', [{ kinds: Array.from({ length: 21 }, () => 'k') }]],
    ['over-long string', [{ projectId: 'p'.repeat(65) }]],
    ['not an object', ['activity']],
    ['extra argument', [{}, 'extra']],
  ])('rejects malformed input before the handler runs: %s', async (_name, args) => {
    const { ipc, call } = setup();
    let ran = false;
    ipc.handle('activity:list', () => {
      ran = true;
      return [];
    });
    const error = errorOf(await call('activity:list', args));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('activity:list');
    expect(ran).toBe(false);
  });

  it('rejects a missing request where an object is required', async () => {
    const { ipc, call } = setup();
    ipc.handle('settings:set', () => SettingsSchema.parse({}));
    expect(errorOf(await call('settings:set', [])).code).toBe('INVALID_INPUT');
    expect(errorOf(await call('settings:set', [{ key: 'not.a.setting', value: 1 }])).code).toBe(
      'INVALID_INPUT',
    );
  });

  it.each([
    ['a foreign page', { url: 'https://evil.example/', parent: null }],
    ['a file URL', { url: 'file:///C:/Windows/win.ini', parent: null }],
    ['a sub-frame of our own page', { url: TRUSTED, parent: {} }],
    ['a destroyed frame', null],
  ])('refuses a request from %s', async (_name, frame) => {
    const { ipc, call, logger } = setup();
    let ran = false;
    ipc.handle('app:getInfo', () => {
      ran = true;
      throw new Error('must not run');
    });
    expect(errorOf(await call('app:getInfo', [{}], frame)).code).toBe('FORBIDDEN_SENDER');
    expect(ran).toBe(false);
    expect(logger.entries.some((e) => e.lvl === 'warn' && e.msg.includes('untrusted sender'))).toBe(true);
  });

  it('refuses new work while shutting down', async () => {
    const { ipc, call } = setup({ shuttingDown: true });
    ipc.handle('app:getInfo', () => {
      throw new Error('must not run');
    });
    const error = errorOf(await call('app:getInfo', [{}]));
    expect(error.code).toBe('SHUTTING_DOWN');
    expect(error.retryable).toBe(true);
  });

  it('passes an AppError through with its code, message and hint, and keeps its details out of the answer', async () => {
    const { ipc, call, logger } = setup();
    ipc.handle('settings:get', () => {
      throw new AppError('NOT_FOUND', 'No such thing.', {
        hint: 'Pick another.',
        details: { secretPath: 'C:\\x' },
      });
    });
    const error = errorOf(await call('settings:get', [{}]));
    expect(error).toEqual({
      code: 'NOT_FOUND',
      message: 'No such thing.',
      hint: 'Pick another.',
      retryable: false,
    });
    expect(JSON.stringify(error)).not.toContain('secretPath');
    expect(logger.entries.some((e) => e.data?.['details'] !== undefined)).toBe(true);
  });

  it('turns an unexpected error into INTERNAL with a generic message and logs the real one', async () => {
    const { ipc, call, logger } = setup();
    ipc.handle('settings:get', () => {
      throw new Error('database exploded at C:\\Users\\me\\secret.db');
    });
    const error = errorOf(await call('settings:get', [{}]));
    expect(error).toEqual({ code: 'INTERNAL', message: INTERNAL_ERROR_MESSAGE, retryable: false });
    expect(logger.entries.find((e) => e.lvl === 'error')?.msg).toBe('unexpected error in handler');
  });

  it('turns a handler that returns the wrong shape into INTERNAL instead of sending it', async () => {
    const { ipc, call, logger } = setup();
    ipc.handle('app:getInfo', () => ({ name: 'x' }) as never);
    expect(errorOf(await call('app:getInfo', [{}])).code).toBe('INTERNAL');
    expect(logger.entries.some((e) => e.msg === 'handler returned an invalid response')).toBe(true);
  });

  it('does not send a response that has fields the schema does not list', async () => {
    const { ipc, call } = setup();
    ipc.handle('app:reportRendererError', () => ({ accepted: true, leaked: 'nope' }) as never);
    const result = await call('app:reportRendererError', [{ kind: 'error', message: 'm' }]);
    expect(errorOf(result).code).toBe('INTERNAL');
    expect(JSON.stringify(result)).not.toContain('nope');
  });

  it('awaits an async handler', async () => {
    const { ipc, call } = setup();
    ipc.handle('activity:list', async () => {
      await Promise.resolve();
      return [];
    });
    expect(await call('activity:list', [{}])).toEqual({ ok: true, value: [] });
  });
});
