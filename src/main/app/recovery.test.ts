import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '@shared/errors';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { removeTempDirs } from '../../../test/helpers/temp';
import { backupsDir, createBackupService, databasePath, inspectBackup, loadMigrations } from '../storage';
import { isRecoverable, runStartupRecovery } from './recovery';

afterEach(removeTempDirs);

const KNOWN = loadMigrations().length;

async function broken() {
  const { db, dir } = await openMigratedDb();
  const backups = createBackupService({ db, dir: backupsDir(dir), logger: memoryLogger() });
  await backups.create('manual');
  db.close();
  writeFileSync(databasePath(dir), 'this file is no longer a database, it is just text text text text');
  const calls: string[] = [];
  const deps = (choose: (labels: string[]) => number) => ({
    userDataDir: dir,
    knownSchemaVersion: KNOWN,
    logFile: '~\\main.log',
    logger: memoryLogger(),
    showBox: (box: { buttons: string[]; detail: string }) => {
      calls.push(`box:${box.buttons.join('|')}`);
      return Promise.resolve(choose(box.buttons));
    },
    openFolder: (path: string) => void calls.push(`open:${path}`),
    relaunch: () => void calls.push('relaunch'),
  });
  return { dir, calls, deps };
}

const corrupt = new AppError('DB_CORRUPT', 'The database file gdcc.db could not be read.');

describe('startup recovery', () => {
  it('only offers a way out for a damaged or newer database', () => {
    expect(isRecoverable(corrupt)).toBe(true);
    expect(isRecoverable(new AppError('DB_NEWER_THAN_APP', 'x'))).toBe(true);
    expect(isRecoverable(new AppError('MIGRATION_FAILED', 'x'))).toBe(false);
    expect(isRecoverable(new Error('x'))).toBe(false);
  });

  it('restores the newest backup, keeps the damaged file, and restarts', async () => {
    const { dir, calls, deps } = await broken();
    const restarting = await runStartupRecovery(corrupt, deps((labels) => labels.indexOf('Restore the newest backup')));
    expect(restarting).toBe(true);
    expect(calls.at(-1)).toBe('relaunch');
    expect(inspectBackup(databasePath(dir))).toMatchObject({ ok: true });
    expect(readdirSync(join(dir, 'data')).some((name) => name.startsWith('gdcc.corrupt-'))).toBe(true);
  });

  it('starts a new database by renaming the damaged one, never deleting it', async () => {
    const { dir, calls, deps } = await broken();
    const restarting = await runStartupRecovery(corrupt, deps((labels) => labels.indexOf('Start a new, empty database')));
    expect(restarting).toBe(true);
    expect(existsSync(databasePath(dir))).toBe(false);
    expect(readdirSync(join(dir, 'data')).filter((name) => name.startsWith('gdcc.corrupt-'))).toHaveLength(1);
    expect(calls.at(-1)).toBe('relaunch');
  });

  it('opens the backups folder and asks again; Quit changes nothing', async () => {
    const { dir, calls, deps } = await broken();
    let n = 0;
    const restarting = await runStartupRecovery(corrupt, deps((labels) => (n++ === 0 ? labels.indexOf('Open the backups folder') : labels.indexOf('Quit'))));
    expect(restarting).toBe(false);
    expect(calls.filter((c) => c.startsWith('box:'))).toHaveLength(2);
    expect(calls).toContain(`open:${backupsDir(dir)}`);
    expect(calls).not.toContain('relaunch');
    expect(readdirSync(join(dir, 'data')).filter((name) => name.startsWith('gdcc.corrupt-'))).toEqual([]);
  });

  it('does not offer a restore when there is no usable backup', async () => {
    const { dir, deps } = await broken();
    writeFileSync(join(backupsDir(dir), readdirSync(backupsDir(dir))[0] as string), 'damaged damaged damaged damaged damaged damaged damaged damaged');
    let labels: string[] = [];
    await runStartupRecovery(corrupt, deps((l) => ((labels = l), l.indexOf('Quit'))));
    expect(labels).toEqual(['Open the backups folder', 'Start a new, empty database', 'Quit']);
  });
});
