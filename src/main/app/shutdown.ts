import type { Logger } from '../logging';

// Graceful shutdown (ARCHITECTURE.md section 12): the quit is deferred while each registered step runs, in order:
// stop accepting IPC work, cancel and clean up processes, record the stop, flush the log, close the database.
// A step that takes too long is abandoned; the whole sequence has a ceiling, after which owned trees are force-killed.

export interface ShutdownCoordinator {
  /** Lower `order` runs first. `signal` aborts when the step's own deadline passes. */
  register(name: string, order: number, stop: (signal: AbortSignal) => Promise<void> | void): void;
  /** Runs every step once; later calls return the same promise. Never rejects. */
  shutdown(reason: string): Promise<void>;
  readonly isShuttingDown: boolean;
}

export interface ShutdownOptions {
  logger: Logger;
  /** Longest a single step may take. */
  stepMs?: number;
  /** Longest the whole sequence may take (10 seconds in the app). */
  totalMs?: number;
  /** Called when the ceiling is hit, before shutdown resolves: force-kill what is still running. */
  onCeiling?: () => Promise<void> | void;
}

export function createShutdownCoordinator(options: ShutdownOptions): ShutdownCoordinator {
  const logger = options.logger.child('shutdown');
  const stepMs = options.stepMs ?? 5000;
  const totalMs = options.totalMs ?? 10_000;
  const steps: { name: string; order: number; stop: (signal: AbortSignal) => Promise<void> | void }[] = [];
  let running: Promise<void> | undefined;

  const runStep = async (step: (typeof steps)[number]): Promise<void> => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, stepMs);
    });
    try {
      const outcome = await Promise.race([
        Promise.resolve(step.stop(controller.signal)).then(() => 'done' as const),
        deadline,
      ]);
      if (outcome === 'timeout')
        logger.warn('shutdown step timed out and was abandoned', { step: step.name, stepMs });
    } catch (error) {
      logger.error('shutdown step failed', { step: step.name, error });
    } finally {
      clearTimeout(timer);
    }
  };

  const sequence = async (reason: string): Promise<void> => {
    logger.info('shutting down', { reason });
    for (const step of [...steps].sort((a, b) => a.order - b.order)) await runStep(step);
    logger.info('shutdown finished');
  };

  return {
    register(name, order, stop) {
      steps.push({ name, order, stop });
    },
    get isShuttingDown() {
      return running !== undefined;
    },
    shutdown(reason) {
      running ??= (async () => {
        let ceiling: NodeJS.Timeout | undefined;
        const hit = new Promise<'ceiling'>((resolve) => {
          ceiling = setTimeout(() => resolve('ceiling'), totalMs);
        });
        const outcome = await Promise.race([sequence(reason).then(() => 'done' as const), hit]);
        clearTimeout(ceiling);
        if (outcome === 'ceiling') {
          logger.error('shutdown hit its ceiling; force-killing what is still running', { totalMs });
          try {
            await options.onCeiling?.();
          } catch (error) {
            logger.error('force kill failed', { error });
          }
        }
      })();
      return running;
    },
  };
}
