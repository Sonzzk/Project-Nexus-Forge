import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import { memoryLogger } from '../../../test/helpers/logger';
import { makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { createBackupService } from './backups';
import { openDb, type Db } from './db';
import { checksumOf, loadMigrations, type Migration } from './migrations';
import { createMigrator } from './migrator';
import { openAppDatabase } from './index';

afterEach(removeTempDirs);

const migration = (version: number, name: string, sql: string): Migration => ({
  version,
  name,
  sql,
  checksum: checksumOf(sql),
});
const SCHEMA = migration(
  1,
  'init',
  'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, app_version TEXT NOT NULL) STRICT; CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT;',
);
const ADD_COLUMN = migration(2, 'add_tag', 'ALTER TABLE notes ADD COLUMN tag TEXT;');

function setup(migrations: Migration[], dir = makeTempDir()) {
  const logger = memoryLogger();
  const db = openDb(join(dir, 'data', 'gdcc.db'));
  const backups = createBackupService({ db, dir: join(dir, 'backups'), logger });
  const migrator = createMigrator({ db, migrations, backups, appVersion: '9.9.9', logger });
  return { dir, db, backups, migrator, logger };
}

const caught = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a rejection');
};

describe('loadMigrations', () => {
  it('loads the bundled SQL files in order, with stable checksums', () => {
    const migrations = loadMigrations();
    expect(migrations.map((m) => m.version)).toEqual(migrations.map((_, i) => i + 1));
    expect(migrations[0]?.name).toBe('init');
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the same with Windows and Unix line endings', () => {
    expect(checksumOf('a\r\nb\r\n')).toBe(checksumOf('a\nb\n'));
  });

  it('rejects gaps, repeats and badly named files', () => {
    expect(() => loadMigrations({ './migrations/0001_a.sql': 'x', './migrations/0003_b.sql': 'y' })).toThrow(
      'without gaps',
    );
    expect(() => loadMigrations({ './migrations/0001_a.sql': 'x', './migrations/0001_b.sql': 'y' })).toThrow(
      'without gaps',
    );
    expect(() => loadMigrations({ './migrations/init.sql': 'x' })).toThrow('not named like');
  });
});

describe('the shipped schema', () => {
  it('creates every Step 4 table on a fresh database and records version 1 without a backup', async () => {
    const dir = makeTempDir();
    const app = await openAppDatabase({ userDataDir: dir, appVersion: '1.2.3', logger: memoryLogger() });
    const tables = app.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(['activity_events', 'process_runs', 'schema_migrations', 'settings']),
    );
    expect(app.schemaVersion).toBe(1);
    expect(app.report).toEqual({ from: 0, to: 1 });
    expect(
      app.db.get<{ app_version: string }>('SELECT app_version FROM schema_migrations')?.app_version,
    ).toBe('1.2.3');
    expect(existsSync(join(dir, 'backups'))).toBe(false);
    app.db.close();
  });

  it('keeps data and makes no new backup when reopened with nothing pending', async () => {
    const dir = makeTempDir();
    const first = await openAppDatabase({ userDataDir: dir, appVersion: '1', logger: memoryLogger() });
    first.db.run(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('ui.density', '\"compact\"', 'now')",
    );
    first.db.close();
    const second = await openAppDatabase({ userDataDir: dir, appVersion: '1', logger: memoryLogger() });
    expect(second.report).toEqual({ from: 1, to: 1 });
    expect(second.db.all('SELECT key FROM settings')).toEqual([{ key: 'ui.density' }]);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
    second.db.close();
  });
});

describe('createMigrator', () => {
  it('applies a migration to a fresh database', async () => {
    const { db, migrator } = setup([SCHEMA]);
    expect(migrator.current()).toBe(0);
    expect(migrator.pending()).toHaveLength(1);
    await expect(migrator.migrate()).resolves.toEqual({ from: 0, to: 1 });
    expect(migrator.current()).toBe(1);
    db.close();
  });

  it('upgrades an existing database: backup made and verified, data kept, new schema applied', async () => {
    const dir = makeTempDir();
    const v1 = setup([SCHEMA], dir);
    await v1.migrator.migrate();
    v1.db.run('INSERT INTO notes (body) VALUES (?)', 'precious');
    v1.db.close();

    const v2 = setup([SCHEMA, ADD_COLUMN], dir);
    const report = await v2.migrator.migrate();
    expect(report.from).toBe(1);
    expect(report.to).toBe(2);
    expect(report.backupPath).toBeDefined();

    // The new schema is in place and the data survived.
    expect(v2.db.all<{ body: string; tag: string | null }>('SELECT body, tag FROM notes')).toEqual([
      { body: 'precious', tag: null },
    ]);
    // The backup is a real database from before the migration.
    const backup = openDb(report.backupPath ?? '', { readOnly: true });
    expect(
      backup.all<{ name: string }>("SELECT name FROM pragma_table_info('notes')").map((c) => c.name),
    ).toEqual(['id', 'body']);
    expect(backup.all<{ body: string }>('SELECT body FROM notes')).toEqual([{ body: 'precious' }]);
    backup.close();
    expect(v2.backups.list().map((b) => b.reason)).toEqual(['pre-migration']);
    v2.db.close();
  });

  it('a failing migration leaves the original database intact and names the backup', async () => {
    const dir = makeTempDir();
    const v1 = setup([SCHEMA], dir);
    await v1.migrator.migrate();
    v1.db.run('INSERT INTO notes (body) VALUES (?)', 'untouched');
    v1.db.close();

    const broken = migration(
      2,
      'broken',
      'ALTER TABLE notes ADD COLUMN tag TEXT; CREATE TABLE half (id INTEGER); THIS IS NOT SQL;',
    );
    const another = migration(3, 'never_runs', 'CREATE TABLE later (id INTEGER);');
    const v2 = setup([SCHEMA, broken, another], dir);
    const error = await caught(v2.migrator.migrate());
    expect(error.code).toBe('MIGRATION_FAILED');
    expect(error.message).toContain('0002 (broken)');
    expect(error.message).toContain('not changed');
    expect(error.hint).toMatch(/gdcc-.*-pre-migration\.db/);

    expect(v2.migrator.current()).toBe(1);
    const tables = v2.db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((t) => t.name);
    expect(tables).not.toContain('half');
    expect(tables).not.toContain('later');
    expect(
      v2.db.all<{ name: string }>("SELECT name FROM pragma_table_info('notes')").map((c) => c.name),
    ).toEqual(['id', 'body']);
    expect(v2.db.all<{ body: string }>('SELECT body FROM notes')).toEqual([{ body: 'untouched' }]);
    v2.db.close();
  });

  it('refuses a database created by a newer app and changes nothing', async () => {
    const dir = makeTempDir();
    const newer = setup([SCHEMA, ADD_COLUMN], dir);
    await newer.migrator.migrate();
    newer.db.close();

    const older = setup([SCHEMA], dir);
    const error = await caught(older.migrator.migrate());
    expect(error.code).toBe('DB_NEWER_THAN_APP');
    expect(error.hint).toContain('Nothing was changed');
    expect(older.backups.list()).toEqual([]);
    older.db.close();
  });

  it('refuses a migration that was edited after it was applied', async () => {
    const dir = makeTempDir();
    const first = setup([SCHEMA], dir);
    await first.migrator.migrate();
    first.db.close();

    const edited = migration(1, 'init', `${SCHEMA.sql} -- sneaky edit`);
    const second = setup([edited], dir);
    const error = await caught(second.migrator.migrate());
    expect(error.code).toBe('MIGRATION_FAILED');
    expect(error.message).toContain('edited after it was applied');
    second.db.close();
  });

  it('does not migrate when the backup cannot be made', async () => {
    const dir = makeTempDir();
    const first = setup([SCHEMA], dir);
    await first.migrator.migrate();
    first.db.close();

    const second = setup([SCHEMA, ADD_COLUMN], dir);
    writeFileSync(join(dir, 'backups'), 'a file where the backups folder should be');
    const error = await caught(second.migrator.migrate());
    expect(error.code).toBe('MIGRATION_FAILED');
    expect(error.message).toContain('backup could not be made');
    expect(second.migrator.current()).toBe(1);
    second.db.close();
  });
});

describe('backups', () => {
  it('keeps only the newest ten pre-migration backups', async () => {
    const dir = makeTempDir();
    const logger = memoryLogger();
    const db: Db = openDb(join(dir, 'gdcc.db'));
    db.exec('CREATE TABLE t (id INTEGER) STRICT');
    let tick = 0;
    const service = createBackupService({
      db,
      dir: join(dir, 'backups'),
      logger,
      now: () => new Date(Date.UTC(2026, 9, 24, 1, 0, tick++)),
    });
    for (let i = 0; i < 13; i++) await service.create('pre-migration');
    await service.create('manual');
    const list = service.list();
    expect(list.filter((b) => b.reason === 'pre-migration')).toHaveLength(10);
    expect(list.filter((b) => b.reason === 'manual')).toHaveLength(1);
    expect(readdirSync(join(dir, 'backups'))).toHaveLength(11);
    db.close();
  });

  it('never overwrites a backup made in the same millisecond', async () => {
    const dir = makeTempDir();
    const db = openDb(join(dir, 'gdcc.db'));
    const same = new Date('2026-10-24T01:00:00.000Z');
    const service = createBackupService({
      db,
      dir: join(dir, 'backups'),
      logger: memoryLogger(),
      now: () => same,
    });
    const a = await service.create('manual');
    const b = await service.create('manual');
    expect(a.path).not.toBe(b.path);
    expect(readFileSync(a.path).length).toBeGreaterThan(0);
    db.close();
  });
});
