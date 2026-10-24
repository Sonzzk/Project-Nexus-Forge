import { describe, expect, it } from 'vitest';
import { memoryLogger } from '../../../test/helpers/logger';
import { createShutdownCoordinator } from './shutdown';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('ShutdownCoordinator', () => {
  it('runs steps in order, regardless of registration order, and marks itself shutting down at once', async () => {
    const ran: string[] = [];
    const shutdown = createShutdownCoordinator({ logger: memoryLogger() });
    shutdown.register('database', 90, () => {
      ran.push('database');
    });
    shutdown.register('processes', 30, async () => {
      await sleep(20);
      ran.push('processes');
    });
    shutdown.register('ipc', 10, () => {
      ran.push('ipc');
    });
    expect(shutdown.isShuttingDown).toBe(false);
    const done = shutdown.shutdown('test');
    expect(shutdown.isShuttingDown).toBe(true);
    await done;
    expect(ran).toEqual(['ipc', 'processes', 'database']);
  });

  it('runs every step once even when shutdown is called again', async () => {
    let calls = 0;
    const shutdown = createShutdownCoordinator({ logger: memoryLogger() });
    shutdown.register('once', 1, () => {
      calls++;
    });
    await Promise.all([shutdown.shutdown('a'), shutdown.shutdown('b')]);
    await shutdown.shutdown('c');
    expect(calls).toBe(1);
  });

  it('carries on after a step throws, and logs it', async () => {
    const logger = memoryLogger();
    const ran: string[] = [];
    const shutdown = createShutdownCoordinator({ logger });
    shutdown.register('bad', 1, () => {
      throw new Error('boom');
    });
    shutdown.register('good', 2, () => {
      ran.push('good');
    });
    await shutdown.shutdown('test');
    expect(ran).toEqual(['good']);
    expect(logger.entries.some((e) => e.lvl === 'error' && e.msg === 'shutdown step failed')).toBe(true);
  });

  it('abandons a step that exceeds its deadline, aborts its signal and continues', async () => {
    const logger = memoryLogger();
    let aborted = false;
    const ran: string[] = [];
    const shutdown = createShutdownCoordinator({ logger, stepMs: 50, totalMs: 5000 });
    shutdown.register('stuck', 1, (signal) => {
      signal.addEventListener('abort', () => (aborted = true));
      return new Promise<void>(() => undefined);
    });
    shutdown.register('after', 2, () => {
      ran.push('after');
    });
    await shutdown.shutdown('test');
    expect(aborted).toBe(true);
    expect(ran).toEqual(['after']);
    expect(logger.entries.some((e) => e.msg === 'shutdown step timed out and was abandoned')).toBe(true);
  });

  it('hits the ceiling, force-kills, and still resolves', async () => {
    let forced = 0;
    const shutdown = createShutdownCoordinator({
      logger: memoryLogger(),
      stepMs: 5000,
      totalMs: 80,
      onCeiling: () => {
        forced++;
      },
    });
    shutdown.register('stuck', 1, () => new Promise<void>(() => undefined));
    await shutdown.shutdown('test');
    expect(forced).toBe(1);
  });

  it('does not force-kill when everything finishes in time', async () => {
    let forced = 0;
    const shutdown = createShutdownCoordinator({
      logger: memoryLogger(),
      totalMs: 500,
      onCeiling: () => {
        forced++;
      },
    });
    shutdown.register('quick', 1, () => undefined);
    await shutdown.shutdown('test');
    await sleep(20);
    expect(forced).toBe(0);
  });
});
