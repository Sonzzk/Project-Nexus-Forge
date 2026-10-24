import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import type { LogLevel } from '@shared/settings';
import { createLogger } from './logger';
import { createRedactor } from './redactor';

afterEach(removeTempDirs);

const lines = (file: string): Record<string, unknown>[] =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('createLogger', () => {
  it('writes one JSON line per entry with time, level, module, message and data', () => {
    const dir = makeTempDir();
    const log = createLogger({
      dir,
      redactor: createRedactor(),
      level: () => 'info',
      now: () => new Date('2026-10-24T01:02:03.456Z'),
    });
    log.child('storage').info('migration applied', { from: 0, to: 1 });
    expect(lines(join(dir, 'main.log'))).toEqual([
      {
        t: '2026-10-24T01:02:03.456Z',
        lvl: 'info',
        mod: 'app.storage',
        msg: 'migration applied',
        data: { from: 0, to: 1 },
      },
    ]);
  });

  it('follows the level setting as it changes', () => {
    const dir = makeTempDir();
    let level: LogLevel = 'warn';
    const log = createLogger({ dir, redactor: createRedactor(), level: () => level });
    log.info('hidden');
    log.warn('shown');
    level = 'debug';
    log.debug('now shown');
    expect(lines(join(dir, 'main.log')).map((entry) => entry['msg'])).toEqual(['shown', 'now shown']);
  });

  it('redacts messages, data and error causes before writing', () => {
    const dir = makeTempDir();
    const log = createLogger({ dir, redactor: createRedactor(), level: () => 'info' });
    log.error('call failed with token=abc123456', {
      key: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv',
      error: new Error('bad', { cause: new Error('password=hunter2') }),
    });
    const text = readFileSync(join(dir, 'main.log'), 'utf8');
    expect(text).not.toContain('abc123456');
    expect(text).not.toContain('AbCdEfGhIjKlMnOpQrStUv');
    expect(text).not.toContain('hunter2');
    expect(text).toContain('[redacted]');
  });

  it('rotates at the size limit and keeps only the configured number of old files', () => {
    const dir = makeTempDir();
    const log = createLogger({
      dir,
      redactor: createRedactor(),
      level: () => 'info',
      maxBytes: 400,
      maxFiles: 3,
    });
    for (let i = 0; i < 60; i++) log.info(`entry number ${i} ${'x'.repeat(40)}`);
    expect(readdirSync(dir).sort()).toEqual(['main.1.log', 'main.2.log', 'main.3.log', 'main.log']);
    for (const name of readdirSync(dir)) expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(400);
    // Newest entries are in main.log, older ones in higher numbers.
    const newest = lines(join(dir, 'main.log')).at(-1);
    expect(newest?.['msg']).toContain('entry number 59');
    const olderFirst = lines(join(dir, 'main.1.log'))[0];
    expect(String(olderFirst?.['msg'])).toMatch(/entry number \d+/);
    expect(existsSync(join(dir, 'main.4.log'))).toBe(false);
  });

  it('continues an existing log after a restart instead of overwriting it', () => {
    const dir = makeTempDir();
    createLogger({ dir, redactor: createRedactor(), level: () => 'info' }).info('first run');
    createLogger({ dir, redactor: createRedactor(), level: () => 'info' }).info('second run');
    expect(lines(join(dir, 'main.log')).map((entry) => entry['msg'])).toEqual(['first run', 'second run']);
  });

  it('never throws when the log cannot be written', () => {
    const dir = makeTempDir();
    const logDir = join(dir, 'logs');
    const log = createLogger({ dir: logDir, redactor: createRedactor(), level: () => 'info' });
    rmSync(logDir, { recursive: true, force: true });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => {
      log.info('lost');
      log.info('also lost');
    }).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
