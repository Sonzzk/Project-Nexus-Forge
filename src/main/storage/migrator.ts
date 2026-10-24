import { basename } from 'node:path';
import { AppError } from '@shared/errors';
import type { Logger } from '../logging';
import type { BackupService } from './backups';
import type { Db } from './db';
import type { Migration } from './migrations';

// Forward-only migrations (ARCHITECTURE.md section 8). Before applying anything to a database that holds data the app
// makes a verified backup; then every pending migration runs in ONE transaction together with its schema_migrations
// row, so a failure leaves the database exactly as it was. An existing database file is never replaced.

export interface MigrationReport {
  from: number;
  to: number;
  backupPath?: string;
}

export interface Migrator {
  /** The schema version in the database (0 for a new, empty file). */
  current(): number;
  pending(): Migration[];
  migrate(): Promise<MigrationReport>;
}

export interface MigratorOptions {
  db: Db;
  migrations: readonly Migration[];
  backups: BackupService;
  appVersion: string;
  logger: Logger;
  now?: () => Date;
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

export function createMigrator(options: MigratorOptions): Migrator {
  const { db, migrations, backups, appVersion, logger } = options;
  const now = options.now ?? (() => new Date());

  const applied = (): AppliedRow[] =>
    db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    ) === undefined
      ? []
      : db.all<AppliedRow>('SELECT version, name, checksum FROM schema_migrations ORDER BY version');

  /** Refuses a database this build cannot safely use: newer than the app, or with a shipped migration edited. */
  const verifyApplied = (rows: AppliedRow[]): void => {
    for (const row of rows) {
      const known = migrations.find((m) => m.version === row.version);
      if (known === undefined)
        throw new AppError(
          'DB_NEWER_THAN_APP',
          `The database was created by a newer version of GameDev Command Center (schema ${row.version}; this version knows ${migrations.length}).`,
          {
            hint: 'Install the newer version of the app, or restore an older backup. Nothing was changed.',
          },
        );
      if (known.checksum !== row.checksum)
        throw new AppError(
          'MIGRATION_FAILED',
          `Migration ${String(row.version).padStart(4, '0')} (${row.name}) was edited after it was applied.`,
          {
            hint: 'Shipped migrations are never edited; add a new migration instead. Nothing was changed.',
          },
        );
    }
  };

  const current = (): number => applied().at(-1)?.version ?? 0;
  const pending = (): Migration[] => migrations.filter((m) => m.version > current());

  return {
    current,
    pending,
    async migrate() {
      const rows = applied();
      verifyApplied(rows);
      const from = rows.at(-1)?.version ?? 0;
      const todo = migrations.filter((m) => m.version > from);
      if (todo.length === 0) return { from, to: from };

      let backupPath: string | undefined;
      if (from > 0) {
        // A brand-new file has nothing to lose; every later migration needs a verified backup first.
        try {
          backupPath = (await backups.create('pre-migration')).path;
        } catch (error) {
          throw new AppError(
            'MIGRATION_FAILED',
            'The database was not updated because a backup could not be made first.',
            {
              hint: 'Check that the disk has free space and the app data folder is writable, then restart. Nothing was changed.',
              cause: error,
            },
          );
        }
      }

      let running = todo[0];
      try {
        db.transaction(() => {
          for (const migration of todo) {
            running = migration;
            db.exec(migration.sql);
            db.run(
              'INSERT INTO schema_migrations (version, name, checksum, applied_at, app_version) VALUES (?, ?, ?, ?, ?)',
              migration.version,
              migration.name,
              migration.checksum,
              now().toISOString(),
              appVersion,
            );
          }
        });
      } catch (error) {
        logger.error('migration failed and was rolled back', {
          version: running?.version,
          name: running?.name,
          error,
        });
        throw new AppError(
          'MIGRATION_FAILED',
          `Migration ${String(running?.version).padStart(4, '0')} (${running?.name}) failed. The database was not changed.`,
          {
            hint:
              backupPath === undefined
                ? 'Details are in the log.'
                : `A backup from before the update is ${basename(backupPath)} in the backups folder. Details are in the log.`,
            cause: error,
          },
        );
      }

      const to = todo.at(-1)?.version ?? from;
      logger.info('migrations applied', { from, to, backupPath });
      return { from, to, ...(backupPath === undefined ? {} : { backupPath }) };
    },
  };
}
