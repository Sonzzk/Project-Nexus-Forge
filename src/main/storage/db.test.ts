import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '@shared/errors';
import { makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { openDb } from './db';

afterEach(removeTempDirs);

const tempDb = () => openDb(join(makeTempDir(), 'data', 'test.db'));

describe('openDb', () => {
  it('creates the file and its folder when missing, with WAL and foreign keys on', () => {
    const path = join(makeTempDir(), 'data', 'new.db');
    const db = openDb(path);
    expect(existsSync(path)).toBe(true);
    expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
    db.close();
  });

  it('refuses a file that is not a database, and leaves the file untouched', () => {
    const path = join(makeTempDir(), 'garbage.db');
    const original = 'this is definitely not a sqlite database'.repeat(20);
    writeFileSync(path, original);
    const error = (() => {
      try {
        openDb(path);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('DB_CORRUPT');
    expect((error as AppError).hint).toContain('restore a backup');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('opens an existing database without changing its data', () => {
    const path = join(makeTempDir(), 'keep.db');
    const first = openDb(path);
    first.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT) STRICT');
    first.run('INSERT INTO t (name) VALUES (?)', 'kept');
    first.close();
    const second = openDb(path);
    expect(second.all<{ name: string }>('SELECT name FROM t')).toEqual([{ name: 'kept' }]);
    second.close();
  });
});

describe('Db', () => {
  it('runs, gets and lists with positional parameters', () => {
    const db = tempDb();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT');
    expect(db.run('INSERT INTO t (name) VALUES (?), (?)', 'a', 'b').changes).toBe(2);
    expect(db.get<{ name: string }>('SELECT name FROM t WHERE name = ?', 'b')).toEqual({ name: 'b' });
    expect(db.get('SELECT name FROM t WHERE name = ?', 'zzz')).toBeUndefined();
    expect(db.all<{ name: string }>('SELECT name FROM t ORDER BY name')).toEqual([
      { name: 'a' },
      { name: 'b' },
    ]);
    db.close();
  });

  it('commits a transaction and rolls it back when the callback throws', () => {
    const db = tempDb();
    db.exec('CREATE TABLE t (name TEXT NOT NULL) STRICT');
    db.transaction(() => db.run('INSERT INTO t VALUES (?)', 'committed'));
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t VALUES (?)', 'lost');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.all<{ name: string }>('SELECT name FROM t')).toEqual([{ name: 'committed' }]);
    db.close();
  });

  it('rolls back only the inner part of a nested transaction that throws', () => {
    const db = tempDb();
    db.exec('CREATE TABLE t (name TEXT NOT NULL) STRICT');
    db.transaction(() => {
      db.run('INSERT INTO t VALUES (?)', 'outer');
      expect(() =>
        db.transaction(() => {
          db.run('INSERT INTO t VALUES (?)', 'inner');
          throw new Error('inner failed');
        }),
      ).toThrow('inner failed');
    });
    expect(db.all<{ name: string }>('SELECT name FROM t')).toEqual([{ name: 'outer' }]);
    db.close();
  });

  it('rejects an async transaction callback instead of committing early', () => {
    const db = tempDb();
    db.exec('CREATE TABLE t (name TEXT NOT NULL) STRICT');
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t VALUES (?)', 'x');
        return Promise.resolve(1);
      }),
    ).toThrow('must not be async');
    expect(db.all('SELECT * FROM t')).toEqual([]);
    db.close();
  });

  it('copies itself with backupTo, including data written before the copy', async () => {
    const dir = makeTempDir();
    const db = openDb(join(dir, 'live.db'));
    db.exec('CREATE TABLE t (name TEXT) STRICT');
    db.run('INSERT INTO t VALUES (?)', 'in the copy');
    await db.backupTo(join(dir, 'copy', 'copy.db'));
    db.close();
    const copy = openDb(join(dir, 'copy', 'copy.db'), { readOnly: true });
    expect(copy.all<{ name: string }>('SELECT name FROM t')).toEqual([{ name: 'in the copy' }]);
    copy.close();
  });

  it('close is safe to call twice', () => {
    const db = tempDb();
    db.close();
    expect(() => db.close()).not.toThrow();
  });
});
