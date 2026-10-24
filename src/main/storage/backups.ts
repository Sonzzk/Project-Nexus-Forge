import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '@shared/errors';
import type { Logger } from '../logging';
import { sealBackup } from './db';

// Backups of the app database only (never project content). Step 8 adds restore, scheduling and the backups table.

export type BackupReason = 'pre-migration' | 'manual' | 'scheduled' | 'pre-restore' | 'pre-import';

export interface BackupInfo {
  path: string;
  createdAt: string;
  reason: BackupReason;
  sizeBytes: number;
}

export interface BackupService {
  /** Copies the database with SQLite's online backup, then opens the copy and runs `quick_check` on it. */
  create(reason: BackupReason): Promise<BackupInfo>;
  /** Newest first. */
  list(): BackupInfo[];
}

export interface BackupServiceOptions {
  /** The live database; only `path` and `backupTo` are used. */
  db: { backupTo(destination: string): Promise<void> };
  dir: string;
  logger: Logger;
  now?: () => Date;
  /** How many backups to keep per reason, newest first (ARCHITECTURE.md section 8: ten; the `backup.keepCount` setting). */
  keep?: number | (() => number);
}

const REASONS: readonly BackupReason[] = ['pre-migration', 'manual', 'scheduled', 'pre-restore', 'pre-import'];
export const BACKUP_FILE_NAME = /^gdcc-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z(?:-\d+)?-([a-z-]+)\.db$/;

export function createBackupService(options: BackupServiceOptions): BackupService {
  const { db, dir, logger } = options;
  const now = options.now ?? (() => new Date());
  const keepOption = options.keep ?? 10;
  const keep = (): number => Math.max(1, typeof keepOption === 'number' ? keepOption : keepOption());

  const list = (): BackupInfo[] => {
    if (!existsSync(dir)) return [];
    const found: BackupInfo[] = [];
    for (const name of readdirSync(dir)) {
      const m = BACKUP_FILE_NAME.exec(name);
      const reason = m?.[8] as BackupReason | undefined;
      if (m === null || reason === undefined || !REASONS.includes(reason)) continue;
      const path = join(dir, name);
      found.push({
        path,
        createdAt: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`,
        reason,
        sizeBytes: statSync(path).size,
      });
    }
    return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.path.localeCompare(a.path));
  };

  /** Keeps the newest `keep` backups of the given reason; the others are removed (only files this service made). */
  const prune = (reason: BackupReason): void => {
    for (const old of list()
      .filter((b) => b.reason === reason)
      .slice(keep())) {
      rmSync(old.path, { force: true });
      logger.info('old backup removed', { file: old.path, reason });
    }
  };

  return {
    list,
    async create(reason) {
      mkdirSync(dir, { recursive: true });
      const stamp = now().toISOString().replace(/[-:]/g, '').replace('.', '');
      let path = join(dir, `gdcc-${stamp}-${reason}.db`);
      for (let n = 2; existsSync(path); n++) path = join(dir, `gdcc-${stamp}-${n}-${reason}.db`);

      try {
        await db.backupTo(path);
        sealBackup(path); // one self-contained file, quick_check on the copy; throws if it is damaged
      } catch (error) {
        rmSync(path, { force: true }); // our own half-written copy
        throw new AppError(
          'INTERNAL',
          'The database backup could not be made or failed its integrity check.',
          {
            hint: 'Check that the disk has free space, then try again.',
            cause: error,
          },
        );
      }
      const info: BackupInfo = {
        path,
        createdAt: now().toISOString(),
        reason,
        sizeBytes: statSync(path).size,
      };
      logger.info('database backup created', { file: path, reason, sizeBytes: info.sizeBytes });
      prune(reason);
      return info;
    },
  };
}
