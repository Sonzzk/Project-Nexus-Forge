import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, constants } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '@shared/errors';
import type { Logger } from '../logging';
import { BACKUP_FILE_NAME } from './backups';

// Restoring the app database (spec §22, §27.6). The database is open while the app runs, so a restore is staged: the
// current data is backed up, a marker names the chosen backup, and the next start swaps the file in before anything opens
// it. Nothing is deleted: the file that was in use is renamed, and a backup of it was made first.

export const DATABASE_FILE = 'gdcc.db';
export const PENDING_RESTORE_FILE = 'pending-restore.json';

export const databasePath = (userDataDir: string): string => join(userDataDir, 'data', DATABASE_FILE);
const markerPath = (userDataDir: string): string => join(userDataDir, 'data', PENDING_RESTORE_FILE);
export const backupsDir = (userDataDir: string): string => join(userDataDir, 'backups');

export type BackupCheck = { ok: true; schemaVersion: number } | { ok: false; reason: string };

/** Opens a backup read-only, runs the integrity check and reads its schema version. Never changes the file. */
export function inspectBackup(path: string): BackupCheck {
  let handle: DatabaseSync | undefined;
  try {
    handle = new DatabaseSync(path, { readOnly: true });
    const verdict = (handle.prepare('PRAGMA quick_check').all() as { quick_check: string }[]).map((r) => r.quick_check).join('; ');
    if (verdict !== 'ok') return { ok: false, reason: `the integrity check said: ${verdict.slice(0, 120)}` };
    const row = handle.prepare('SELECT max(version) AS version FROM schema_migrations').get() as { version: number | null } | undefined;
    if (row?.version === null || row?.version === undefined) return { ok: false, reason: 'it has no schema version' };
    return { ok: true, schemaVersion: row.version };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.slice(0, 120) : 'it could not be opened' };
  } finally {
    try {
      handle?.close();
    } catch {
      // nothing more to do with a handle that will not close
    }
  }
}

const stampOf = (date: Date): string => date.toISOString().replace(/[-:]/g, '').replace('.', '');

/**
 * Puts `source` in place of the database file. The file that was there (and its WAL side files, which must never be paired
 * with a different database) is renamed, not deleted. Only call this while the database is closed.
 */
export function replaceDatabase(options: { userDataDir: string; source: string; kind: 'replaced' | 'corrupt'; now?: () => Date }): { movedTo?: string } {
  const target = databasePath(options.userDataDir);
  const stamp = stampOf((options.now ?? (() => new Date()))());
  const moved: [string, string][] = [];
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const from = target + suffix;
      if (!existsSync(from)) continue;
      const to = join(options.userDataDir, 'data', `gdcc.${options.kind}-${stamp}.db${suffix}`);
      renameSync(from, to);
      moved.push([from, to]);
    }
    copyFileSync(options.source, target, constants.COPYFILE_EXCL);
  } catch (error) {
    for (const [from, to] of moved.reverse()) {
      try {
        renameSync(to, from); // put the original back
      } catch {
        // The renamed copy is still next to the original path; the error below says where.
      }
    }
    throw new AppError('INTERNAL', 'The database could not be replaced. Your original data was left in place.', {
      hint: 'Check that the app data folder is writable and the disk has free space, then try again.',
      cause: error,
    });
  }
  const first = moved[0];
  return first === undefined ? {} : { movedTo: first[1] };
}

/** Validates a backup chosen by file name from the backups folder; never accepts a path. */
export function resolveBackup(userDataDir: string, backupId: string, knownSchemaVersion: number): string {
  if (backupId !== basename(backupId) || !BACKUP_FILE_NAME.test(backupId))
    throw new AppError('INVALID_INPUT', "That is not one of the app's backups.", { hint: 'Choose a backup from the list.' });
  const path = join(backupsDir(userDataDir), backupId);
  if (!existsSync(path)) throw new AppError('NOT_FOUND', 'That backup no longer exists.', { hint: 'Reload the list of backups.' });
  const check = inspectBackup(path);
  if (!check.ok)
    throw new AppError('DB_CORRUPT', `That backup cannot be used: ${check.reason}.`, { hint: 'Choose another backup. Nothing was changed.' });
  if (check.schemaVersion > knownSchemaVersion)
    throw new AppError('DB_NEWER_THAN_APP', 'That backup was made by a newer version of the app.', {
      hint: 'Install the newer version to use it, or choose an older backup. Nothing was changed.',
    });
  return path;
}

/** Records the chosen backup so the next start restores it. The caller has already backed up the current database. */
export function stageRestore(options: { userDataDir: string; backupId: string; knownSchemaVersion: number; now?: () => Date }): void {
  resolveBackup(options.userDataDir, options.backupId, options.knownSchemaVersion);
  writeFileSync(markerPath(options.userDataDir), JSON.stringify({ backup: options.backupId, stagedAt: (options.now ?? (() => new Date()))().toISOString() }));
}

export function cancelStagedRestore(userDataDir: string): void {
  rmSync(markerPath(userDataDir), { force: true });
}

export type PendingRestoreOutcome = { restoredFrom: string; replacedFile?: string } | { failed: string };

/** At startup, before the database opens: carries out a staged restore. Returns undefined when none is staged. */
export function applyPendingRestore(options: { userDataDir: string; knownSchemaVersion: number; logger: Logger; now?: () => Date }): PendingRestoreOutcome | undefined {
  const marker = markerPath(options.userDataDir);
  if (!existsSync(marker)) return undefined;
  const fail = (reason: string): PendingRestoreOutcome => {
    options.logger.error('staged restore was not applied', { reason });
    rmSync(marker, { force: true }); // never retry a restore that failed
    return { failed: reason };
  };
  let backupId: unknown;
  try {
    backupId = (JSON.parse(readFileSync(marker, 'utf8')) as { backup?: unknown }).backup;
  } catch {
    return fail('the restore request could not be read');
  }
  if (typeof backupId !== 'string') return fail('the restore request did not name a backup');
  try {
    const source = resolveBackup(options.userDataDir, backupId, options.knownSchemaVersion);
    const { movedTo } = replaceDatabase({ userDataDir: options.userDataDir, source, kind: 'replaced', ...(options.now === undefined ? {} : { now: options.now }) });
    rmSync(marker, { force: true });
    options.logger.info('database restored from backup', { backup: backupId, movedTo });
    return { restoredFrom: backupId, ...(movedTo === undefined ? {} : { replacedFile: basename(movedTo) }) };
  } catch (error) {
    return fail(error instanceof AppError ? error.message : 'the backup could not be copied');
  }
}

/** The newest backup that passes its integrity check and was made by this version or older, or undefined. */
export function newestUsableBackup(userDataDir: string, knownSchemaVersion: number): string | undefined {
  const dir = backupsDir(userDataDir);
  if (!existsSync(dir)) return undefined;
  const names = readdirSync(dir).filter((name) => BACKUP_FILE_NAME.test(name)).sort().reverse(); // names start with a UTC time stamp
  for (const name of names) {
    const check = inspectBackup(join(dir, name));
    if (check.ok && check.schemaVersion <= knownSchemaVersion) return name;
  }
  return undefined;
}

/** For a database that cannot be opened: renames it (and its side files) to `gdcc.corrupt-<time>.db`. The next start creates a new one. */
export function setAsideDatabase(userDataDir: string, now: () => Date = () => new Date()): string | undefined {
  const target = databasePath(userDataDir);
  const stamp = stampOf(now());
  let renamed: string | undefined;
  for (const suffix of ['', '-wal', '-shm']) {
    if (!existsSync(target + suffix)) continue;
    const to = join(userDataDir, 'data', `gdcc.corrupt-${stamp}.db${suffix}`);
    renameSync(target + suffix, to);
    renamed ??= to;
  }
  return renamed;
}
