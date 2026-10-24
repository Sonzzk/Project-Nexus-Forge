import { join } from 'node:path';
import type { Logger } from '../logging';
import { createBackupService, type BackupService } from './backups';
import { openDb, type Db } from './db';
import { loadMigrations, type Migration } from './migrations';
import { createMigrator, type MigrationReport, type Migrator } from './migrator';

export type { BackupInfo, BackupReason, BackupService } from './backups';
export type { Db, SqlValue } from './db';
export type { Migration } from './migrations';
export type { MigrationReport, Migrator } from './migrator';
export { createBackupService } from './backups';
export { openDb } from './db';
export { loadMigrations } from './migrations';
export { createMigrator } from './migrator';

export interface AppDatabase {
  db: Db;
  migrator: Migrator;
  backups: BackupService;
  report: MigrationReport;
  schemaVersion: number;
}

export interface OpenAppDatabaseOptions {
  /** App data folder (`%APPDATA%\GameDevCommandCenter`); the database lives in `data\`, backups in `backups\`. */
  userDataDir: string;
  appVersion: string;
  logger: Logger;
  migrations?: readonly Migration[];
}

export const DATABASE_FILE = 'gdcc.db';

/**
 * Opens the app database (creating it only if the file does not exist), then applies pending migrations.
 * Throws AppError DB_CORRUPT, DB_NEWER_THAN_APP or MIGRATION_FAILED, each with a recovery hint; nothing is replaced or deleted.
 */
export async function openAppDatabase(options: OpenAppDatabaseOptions): Promise<AppDatabase> {
  const { userDataDir, appVersion, logger } = options;
  const db = openDb(join(userDataDir, 'data', DATABASE_FILE));
  try {
    const backups = createBackupService({ db, dir: join(userDataDir, 'backups'), logger });
    const migrator = createMigrator({
      db,
      migrations: options.migrations ?? loadMigrations(),
      backups,
      appVersion,
      logger,
    });
    const report = await migrator.migrate();
    return { db, migrator, backups, report, schemaVersion: report.to };
  } catch (error) {
    db.close();
    throw error;
  }
}
