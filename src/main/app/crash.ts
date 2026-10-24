import type { ActivityLog } from '../logging';
import type { Logger } from '../logging';

// Crash capture (ARCHITECTURE.md section 11): main logs uncaught errors, unhandled rejections and processes that went
// away. Nothing is uploaded. Fatal ones are shown to the user once, with where the log is.

export interface Emitter {
  on(event: string, listener: (...args: never[]) => void): unknown;
}

export interface CrashHandlerOptions {
  logger: Logger;
  /** Optional until the database is open. */
  activity?: () => ActivityLog | undefined;
  processEvents: Emitter;
  appEvents: Emitter;
  /** Shown for an uncaught exception, which can leave the app in an unknown state. */
  onFatal: (error: unknown) => void;
}

export function installCrashHandlers(options: CrashHandlerOptions): void {
  const { logger, processEvents, appEvents } = options;
  const log = logger.child('crash');
  const note = (kind: string, summary: string, details: Record<string, unknown>): void => {
    try {
      options.activity?.()?.record({ kind, severity: 'error', summary, details });
    } catch {
      // The database may be the thing that failed; the log has it.
    }
  };

  processEvents.on('uncaughtException', (error: unknown) => {
    log.error('uncaught exception in the main process', { error });
    note('app.crash', 'The app hit an unexpected error. Details are in the log.', {});
    options.onFatal(error);
  });
  processEvents.on('unhandledRejection', (reason: unknown) => {
    log.error('unhandled promise rejection in the main process', { reason });
    note('app.crash', 'An operation failed unexpectedly. Details are in the log.', {});
  });
  appEvents.on(
    'render-process-gone',
    (_event: unknown, _contents: unknown, details: { reason?: string; exitCode?: number }) => {
      log.error('the window process went away', { reason: details.reason, exitCode: details.exitCode });
      note(
        'app.render-process-gone',
        `The window stopped working (${details.reason ?? 'unknown reason'}). Restart the app.`,
        { reason: details.reason },
      );
    },
  );
  appEvents.on(
    'child-process-gone',
    (_event: unknown, details: { type?: string; reason?: string; exitCode?: number }) => {
      log.error('a helper process went away', {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
      });
    },
  );
}
