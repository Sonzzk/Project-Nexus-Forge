import type { Logger } from '../logging';
import type { BackupInfo, BackupService } from './backups';

// Optional scheduled backups (spec §22). While the app runs it checks every few minutes whether the newest scheduled backup
// is older than the interval and, if so, makes one. A failure is reported and retried at the next check; it never stops the app.

export interface BackupScheduler {
  /** One check now; resolves to the new backup, or undefined when disabled, not yet due, or failed. */
  check(): Promise<BackupInfo | undefined>;
  start(): void;
  stop(): void;
}

export interface BackupSchedulerOptions {
  backups: BackupService;
  enabled: () => boolean;
  intervalHours: () => number;
  logger: Logger;
  onCreated?: (info: BackupInfo) => void;
  onFailed?: (error: unknown) => void;
  now?: () => Date;
  /** How often to check; the default is 10 minutes. */
  checkEveryMs?: number;
}

export function createBackupScheduler(options: BackupSchedulerOptions): BackupScheduler {
  const { backups, logger } = options;
  const now = options.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;

  const check = async (): Promise<BackupInfo | undefined> => {
    if (busy || !options.enabled()) return undefined;
    const last = backups.list().find((backup) => backup.reason === 'scheduled');
    if (last !== undefined && now().getTime() - new Date(last.createdAt).getTime() < options.intervalHours() * 3_600_000) return undefined;
    busy = true;
    try {
      const info = await backups.create('scheduled');
      options.onCreated?.(info);
      return info;
    } catch (error) {
      logger.error('scheduled backup failed', { error });
      options.onFailed?.(error);
      return undefined;
    } finally {
      busy = false;
    }
  };

  return {
    check,
    start() {
      if (timer !== undefined) return;
      setTimeout(() => void check(), 30_000).unref(); // not at the very start, when the app is busy
      timer = setInterval(() => void check(), options.checkEveryMs ?? 600_000);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
