import { join } from 'node:path';
import { openDb, loadMigrations, createBackupService, createMigrator, type Db } from '../../src/main/storage';
import { memoryLogger } from './logger';
import { closeOnCleanup, makeTempDir } from './temp';

/** A fresh, fully migrated database in a temp folder. The caller closes it. */
export async function openMigratedDb(dir = makeTempDir()): Promise<{ db: Db; dir: string }> {
  const logger = memoryLogger();
  const db = openDb(join(dir, 'data', 'gdcc.db'));
  const backups = createBackupService({ db, dir: join(dir, 'backups'), logger });
  await createMigrator({ db, migrations: loadMigrations(), backups, appVersion: 'test', logger }).migrate();
  closeOnCleanup(() => db.close());
  return { db, dir };
}
