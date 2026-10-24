import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { createBackupService } from './backups';
import { openDb } from './db';
import { loadMigrations } from './migrations';
import {
  applyPendingRestore,
  backupsDir,
  databasePath,
  inspectBackup,
  newestUsableBackup,
  PENDING_RESTORE_FILE,
  replaceDatabase,
  resolveBackup,
  setAsideDatabase,
  stageRestore,
} from './restore';

afterEach(removeTempDirs);

const KNOWN = loadMigrations().length;

/** A migrated database with one marker setting, and a service that backs it up. */
async function setup() {
  const { db, dir } = await openMigratedDb();
  const logger = memoryLogger();
  let tick = 0;
  const backups = createBackupService({ db, dir: backupsDir(dir), logger, now: () => new Date(Date.UTC(2026, 9, 24, 1, 0, tick++)) });
  const mark = (value: string): void => {
    db.run("INSERT INTO settings (key, value_json, updated_at) VALUES ('marker', ?, '2026-10-24T00:00:00.000Z') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json", JSON.stringify(value));
  };
  const marker = (path: string): string | undefined => {
    const other = openDb(path, { readOnly: true });
    try {
      const row = other.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'marker'");
      return row === undefined ? undefined : (JSON.parse(row.value_json) as string);
    } finally {
      other.close();
    }
  };
  return { db, dir, logger, backups, mark, marker };
}

describe('inspectBackup', () => {
  it('accepts a good backup and reports its schema version', async () => {
    const { backups } = await setup();
    const info = await backups.create('manual');
    expect(inspectBackup(info.path)).toEqual({ ok: true, schemaVersion: KNOWN });
  });

  it('rejects a file that is not a database, an empty file, and a database without a schema version', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'junk.db'), 'this is not sqlite at all, just some text to fill the header area..........');
    writeFileSync(join(dir, 'empty.db'), '');
    expect(inspectBackup(join(dir, 'junk.db')).ok).toBe(false);
    expect(inspectBackup(join(dir, 'empty.db')).ok).toBe(false);
    const plain = openDb(join(dir, 'plain.db'));
    plain.exec('CREATE TABLE t (a INTEGER)');
    plain.close();
    expect(inspectBackup(join(dir, 'plain.db'))).toMatchObject({ ok: false });
  });

  it('does not change the file it inspects', async () => {
    const { backups } = await setup();
    const info = await backups.create('manual');
    const before = readdirSync(backupsDir(join(info.path, '..', '..')));
    inspectBackup(info.path);
    expect(readdirSync(backupsDir(join(info.path, '..', '..')))).toEqual(before);
  });
});

describe('resolveBackup', () => {
  it('only accepts file names from the backups folder: no paths, no other names, no missing files', async () => {
    const { dir, backups } = await setup();
    const info = await backups.create('manual');
    const id = info.path.split(/[\\/]/).at(-1) as string;
    expect(resolveBackup(dir, id, KNOWN)).toBe(info.path);
    const codeOf = (fn: () => unknown): string | undefined => {
      try {
        fn();
      } catch (error) {
        return (error as AppError).code;
      }
      return undefined;
    };
    expect(codeOf(() => resolveBackup(dir, info.path, KNOWN))).toBe('INVALID_INPUT');
    expect(codeOf(() => resolveBackup(dir, '..\\data\\gdcc.db', KNOWN))).toBe('INVALID_INPUT');
    expect(codeOf(() => resolveBackup(dir, 'gdcc-20260101T000000000Z-manual.db', KNOWN))).toBe('NOT_FOUND');
  });

  it('refuses a damaged backup and one made by a newer version', async () => {
    const { dir, backups } = await setup();
    const info = await backups.create('manual');
    const id = info.path.split(/[\\/]/).at(-1) as string;
    expect(() => resolveBackup(dir, id, KNOWN - 1)).toThrow(/newer version/);
    writeFileSync(join(backupsDir(dir), 'gdcc-20260102T000000000Z-manual.db'), 'garbage garbage garbage garbage garbage garbage garbage garbage');
    expect(() => resolveBackup(dir, 'gdcc-20260102T000000000Z-manual.db', KNOWN)).toThrow(/cannot be used/);
  });
});

describe('staged restore', () => {
  it('swaps the chosen backup in at the next start, keeps the replaced file, and removes the marker', async () => {
    const { db, dir, logger, backups, mark, marker } = await setup();
    mark('old');
    const wanted = await backups.create('manual');
    mark('new');
    const id = wanted.path.split(/[\\/]/).at(-1) as string;

    stageRestore({ userDataDir: dir, backupId: id, knownSchemaVersion: KNOWN });
    expect(existsSync(join(dir, 'data', PENDING_RESTORE_FILE))).toBe(true);
    db.close(); // the app quits; the next start applies the restore

    const outcome = applyPendingRestore({ userDataDir: dir, knownSchemaVersion: KNOWN, logger, now: () => new Date('2026-10-24T02:00:00.000Z') });
    expect(outcome).toMatchObject({ restoredFrom: id });
    expect(existsSync(join(dir, 'data', PENDING_RESTORE_FILE))).toBe(false);
    expect(marker(databasePath(dir))).toBe('old');
    const replaced = readdirSync(join(dir, 'data')).filter((name) => name.startsWith('gdcc.replaced-'));
    expect(replaced).toHaveLength(1);
    expect(marker(join(dir, 'data', replaced[0] as string))).toBe('new'); // nothing was lost
    expect(readdirSync(join(dir, 'data')).filter((n) => n.startsWith('gdcc.db-'))).toEqual([]); // no stale side files next to the restored database
  });

  it('does nothing when no restore is staged', async () => {
    const { dir, logger } = await setup();
    expect(applyPendingRestore({ userDataDir: dir, knownSchemaVersion: KNOWN, logger })).toBeUndefined();
  });

  it('leaves the database exactly as it was when the staged backup turned bad, and does not retry', async () => {
    const { db, dir, logger, backups, mark, marker } = await setup();
    mark('keep me');
    const info = await backups.create('manual');
    const id = info.path.split(/[\\/]/).at(-1) as string;
    stageRestore({ userDataDir: dir, backupId: id, knownSchemaVersion: KNOWN });
    writeFileSync(info.path, 'the backup was damaged after it was chosen......................');
    db.close();

    const outcome = applyPendingRestore({ userDataDir: dir, knownSchemaVersion: KNOWN, logger });
    expect(outcome).toMatchObject({ failed: expect.stringContaining('cannot be used') as unknown });
    expect(marker(databasePath(dir))).toBe('keep me');
    expect(existsSync(join(dir, 'data', PENDING_RESTORE_FILE))).toBe(false);
    expect(readdirSync(join(dir, 'data')).filter((name) => name.startsWith('gdcc.replaced-'))).toEqual([]);
  });

  it('refuses a marker that names something else', async () => {
    const { db, dir, logger, marker, mark } = await setup();
    mark('safe');
    db.close();
    writeFileSync(join(dir, 'data', PENDING_RESTORE_FILE), JSON.stringify({ backup: '..\\..\\evil.db' }));
    expect(applyPendingRestore({ userDataDir: dir, knownSchemaVersion: KNOWN, logger })).toMatchObject({ failed: expect.any(String) as unknown });
    writeFileSync(join(dir, 'data', PENDING_RESTORE_FILE), 'not json');
    expect(applyPendingRestore({ userDataDir: dir, knownSchemaVersion: KNOWN, logger })).toMatchObject({ failed: expect.any(String) as unknown });
    expect(marker(databasePath(dir))).toBe('safe');
  });
});

describe('startup recovery helpers', () => {
  it('newestUsableBackup skips damaged and too-new backups and returns the newest good one', async () => {
    const { dir, backups, mark } = await setup();
    mark('a');
    const good = await backups.create('manual');
    mark('b');
    const newerGood = await backups.create('scheduled');
    writeFileSync(join(backupsDir(dir), 'gdcc-20300101T000000000Z-manual.db'), 'damaged damaged damaged damaged damaged damaged damaged damaged');
    expect(newestUsableBackup(dir, KNOWN)).toBe(newerGood.path.split(/[\\/]/).at(-1));
    expect(newestUsableBackup(dir, KNOWN - 1)).toBeUndefined();
    expect(good.path).not.toBe(newerGood.path);
    expect(newestUsableBackup(makeTempDir(), KNOWN)).toBeUndefined();
  });

  it('replaceDatabase renames the unusable file and its side files instead of deleting them', async () => {
    const { db, dir, backups } = await setup();
    const info = await backups.create('manual');
    db.close();
    writeFileSync(`${databasePath(dir)}-wal`, 'stale wal');
    const { movedTo } = replaceDatabase({ userDataDir: dir, source: info.path, kind: 'corrupt', now: () => new Date('2026-10-24T03:00:00.000Z') });
    expect(movedTo).toContain('gdcc.corrupt-20261024T030000000Z.db');
    const names = readdirSync(join(dir, 'data'));
    expect(names).toContain('gdcc.corrupt-20261024T030000000Z.db-wal');
    expect(names).not.toContain('gdcc.db-wal');
    expect(inspectBackup(databasePath(dir))).toMatchObject({ ok: true });
  });

  it('setAsideDatabase renames a damaged database so the next start creates a new one', async () => {
    const { db, dir } = await setup();
    db.close();
    writeFileSync(databasePath(dir), 'garbage');
    const moved = setAsideDatabase(dir, () => new Date('2026-10-24T04:00:00.000Z'));
    expect(moved).toContain('gdcc.corrupt-');
    expect(existsSync(databasePath(dir))).toBe(false);
    expect(readdirSync(join(dir, 'data'))).toContain('gdcc.corrupt-20261024T040000000Z.db');
    expect(setAsideDatabase(dir)).toBeUndefined();
  });
});
