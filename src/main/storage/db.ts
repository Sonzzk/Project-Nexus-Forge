import { mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { AppError } from '@shared/errors';

// The only module that touches node:sqlite (ARCHITECTURE.md sections 4 and 8). One connection, owned by the main thread.

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface Db {
  readonly path: string;
  run(sql: string, ...params: SqlValue[]): { changes: number };
  // The caller names the row type, so T appears once by design.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  get<T>(sql: string, ...params: SqlValue[]): T | undefined;

  all<T>(sql: string, ...params: SqlValue[]): T[];
  /** Runs SQL that has no parameters and may hold several statements (migrations). */
  exec(sql: string): void;
  /** BEGIN IMMEDIATE ... COMMIT, ROLLBACK on throw; a nested call becomes a savepoint. The callback must be synchronous. */
  transaction<T>(fn: () => T): T;
  /** Copies the live database to `destination` with SQLite's online backup. */
  backupTo(destination: string): Promise<void>;
  /** Checkpoints the WAL and closes the connection. Safe to call twice. */
  close(): void;
}

export interface OpenOptions {
  readOnly?: boolean;
}

const RECOVERY_HINT =
  'Nothing was changed or deleted. Close the app, then restore a backup from the backups folder, or move the damaged file aside to start a new database.';

export function corruptError(path: string, cause: unknown, detail?: string): AppError {
  return new AppError(
    'DB_CORRUPT',
    `The database file ${basename(path)} could not be read${detail ? ` (${detail})` : ''}.`,
    {
      hint: RECOVERY_HINT,
      cause,
    },
  );
}

const verdictOf = (handle: DatabaseSync): string =>
  (handle.prepare('PRAGMA quick_check').all() as { quick_check: string }[])
    .map((row) => row.quick_check)
    .join('; ');

/** Turns a fresh backup copy into one self-contained file (no WAL side files) and runs `quick_check` on it. */
export function sealBackup(path: string): void {
  let handle: DatabaseSync | undefined;
  try {
    handle = new DatabaseSync(path);
    handle.exec('PRAGMA journal_mode = DELETE');
    const verdict = verdictOf(handle);
    if (verdict !== 'ok')
      throw corruptError(path, undefined, `integrity check said: ${verdict.slice(0, 200)}`);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw corruptError(path, error);
  } finally {
    handle?.close();
  }
}

/** Opens (or, if the file does not exist, creates) the database and checks its integrity. Never replaces an existing file. */
export function openDb(path: string, options: OpenOptions = {}): Db {
  const readOnly = options.readOnly ?? false;
  if (!readOnly) mkdirSync(dirname(path), { recursive: true });

  let handle: DatabaseSync | undefined;
  try {
    handle = new DatabaseSync(path, { readOnly, enableForeignKeyConstraints: true });
    handle.exec('PRAGMA busy_timeout = 5000');
    if (!readOnly) {
      handle.exec('PRAGMA journal_mode = WAL');
      handle.exec('PRAGMA synchronous = FULL');
    }
    const verdict = verdictOf(handle);
    if (verdict !== 'ok')
      throw corruptError(path, undefined, `integrity check said: ${verdict.slice(0, 200)}`);
  } catch (error) {
    try {
      handle?.close();
    } catch {
      // The handle is already unusable; the original error is the useful one.
    }
    if (error instanceof AppError) throw error;
    throw corruptError(path, error);
  }

  const db = handle;
  let depth = 0;
  let closed = false;

  const statement = (
    sql: string,
    params: SqlValue[],
  ): { run: () => { changes: number }; all: () => unknown[]; get: () => unknown } => {
    const prepared = db.prepare(sql);
    return {
      run: () => ({ changes: Number(prepared.run(...params).changes) }),
      all: () => prepared.all(...params),
      get: () => prepared.get(...params),
    };
  };

  return {
    path,
    run: (sql, ...params) => statement(sql, params).run(),
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    get: <T>(sql: string, ...params: SqlValue[]) => statement(sql, params).get() as T | undefined,

    all: <T>(sql: string, ...params: SqlValue[]) => statement(sql, params).all() as T[],
    exec: (sql) => db.exec(sql),
    transaction<T>(fn: () => T): T {
      const savepoint = `gdcc_sp_${depth}`;
      db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
      depth++;
      try {
        const result = fn();
        if (result instanceof Promise)
          throw new AppError('INTERNAL', 'A database transaction callback must not be async.');
        depth--;
        db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        depth--;
        db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw error;
      }
    },
    async backupTo(destination) {
      mkdirSync(dirname(destination), { recursive: true });
      await backup(db, destination);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        if (!readOnly) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        db.close();
      }
    },
  };
}
