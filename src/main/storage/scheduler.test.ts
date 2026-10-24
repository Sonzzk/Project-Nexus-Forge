import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { removeTempDirs } from '../../../test/helpers/temp';
import { createBackupService } from './backups';
import { createBackupScheduler } from './scheduler';

afterEach(removeTempDirs);

async function setup(keep: () => number = () => 10) {
  const { db, dir } = await openMigratedDb();
  const logger = memoryLogger();
  const clock = { now: Date.parse('2026-10-24T10:00:00Z') };
  const backups = createBackupService({ db, dir: join(dir, 'backups'), logger, now: () => new Date(clock.now), keep });
  const settings = { enabled: true, hours: 24 };
  const events: string[] = [];
  const scheduler = createBackupScheduler({
    backups,
    enabled: () => settings.enabled,
    intervalHours: () => settings.hours,
    logger,
    now: () => new Date(clock.now),
    onCreated: () => events.push('created'),
    onFailed: () => events.push('failed'),
  });
  return { db, backups, clock, settings, events, scheduler };
}

describe('scheduled backups', () => {
  it('does nothing while switched off', async () => {
    const { scheduler, settings, backups } = await setup();
    settings.enabled = false;
    expect(await scheduler.check()).toBeUndefined();
    expect(backups.list()).toEqual([]);
  });

  it('makes a backup when none exists, then waits for the interval', async () => {
    const { scheduler, clock, backups, events } = await setup();
    expect((await scheduler.check())?.reason).toBe('scheduled');
    clock.now += 23 * 3_600_000;
    expect(await scheduler.check()).toBeUndefined();
    clock.now += 2 * 3_600_000;
    expect((await scheduler.check())?.reason).toBe('scheduled');
    expect(backups.list()).toHaveLength(2);
    expect(events).toEqual(['created', 'created']);
  });

  it('a manual backup does not count as the scheduled one', async () => {
    const { scheduler, backups } = await setup();
    await backups.create('manual');
    expect((await scheduler.check())?.reason).toBe('scheduled');
  });

  it('reports a failure and tries again at the next check instead of stopping', async () => {
    const { scheduler, db, events, backups } = await setup();
    const original = db.backupTo.bind(db);
    db.backupTo = () => Promise.reject(new Error('disk full'));
    expect(await scheduler.check()).toBeUndefined();
    expect(events).toEqual(['failed']);
    db.backupTo = original;
    expect((await scheduler.check())?.reason).toBe('scheduled');
    expect(backups.list()).toHaveLength(1);
  });

  it('start and stop are safe to repeat', async () => {
    const { scheduler } = await setup();
    scheduler.start();
    scheduler.start();
    scheduler.stop();
    scheduler.stop();
  });
});

describe('backup retention', () => {
  it('keeps the newest N of each reason, following the setting, and never touches other reasons', async () => {
    let keep = 3;
    const { backups, clock } = await setup(() => keep);
    for (let i = 0; i < 5; i++) {
      clock.now += 1000;
      await backups.create('scheduled');
    }
    clock.now += 1000;
    await backups.create('manual');
    clock.now += 1000;
    await backups.create('pre-restore');
    expect(backups.list().filter((b) => b.reason === 'scheduled')).toHaveLength(3);
    expect(backups.list().map((b) => b.reason).sort()).toEqual(['manual', 'pre-restore', 'scheduled', 'scheduled', 'scheduled']);
    keep = 1;
    clock.now += 1000;
    await backups.create('scheduled');
    expect(backups.list().filter((b) => b.reason === 'scheduled')).toHaveLength(1);
    expect(backups.list().filter((b) => b.reason === 'manual')).toHaveLength(1);
  });
});
