import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { createActivityLog } from './activity';
import { createRedactor } from './redactor';
import { createRetention, type RetentionSettings } from './retention';

afterEach(removeTempDirs);

const NOW = new Date('2026-11-02T12:00:00.000Z');
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString();

async function env(initial: Partial<RetentionSettings> = {}) {
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const activity = createActivityLog({ db, redactor: createRedactor(), logger, now: () => NOW });
  const logDir = join(makeTempDir(), 'logs');
  mkdirSync(logDir, { recursive: true });
  for (const name of ['main.log', 'main.1.log', 'main.2.log', 'main.3.log', 'main.4.log', 'main.5.log', 'other.txt']) writeFileSync(join(logDir, name), 'x');
  const settings: RetentionSettings = { activityDays: 30, processRunDays: 10, sessionDays: 20, usageDays: 40, logFiles: 5, ...initial };
  const retention = createRetention({ db, activity, logger, logDir, settings: () => settings, now: () => NOW });
  const put = {
    activity: (id: string, at: string) => db.run("INSERT INTO activity_events (id, occurred_at, kind, severity, summary) VALUES (?, ?, 'x.y', 'info', 'old')", id, at),
    process: (id: string, status: string, started: string, ended: string | null) =>
      db.run("INSERT INTO process_runs (id, owner_kind, owner_id, purpose, executable, args_json, cwd, started_at, ended_at, status) VALUES (?, 'git', 'o', 'p', 'git', '[]', 'c', ?, ?, ?)", id, started, ended, status),
    usage: (id: string, status: string, at: string) => db.run("INSERT INTO usage_log (id, purpose, provider_id, location, status, started_at) VALUES (?, 'agent-run', 'ollama', 'local', ?, ?)", id, status, at),
  };
  const count = (table: string): number => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;
  return { db, activity, logDir, settings, retention, put, count };
}

describe('retention limits', () => {
  it('delete old activity, finished process records and usage rows, and keep everything newer', async () => {
    const e = await env();
    e.put.activity('a-old', daysAgo(31));
    e.put.activity('a-new', daysAgo(29));
    e.put.process('p-old', 'exited', daysAgo(12), daysAgo(12));
    e.put.process('p-new', 'exited', daysAgo(9), daysAgo(9));
    e.put.usage('u-old', 'completed', daysAgo(41));
    e.put.usage('u-new', 'completed', daysAgo(39));
    const result = e.retention.prune();
    expect(result).toMatchObject({ activity: 1, processRuns: 1, usage: 1 });
    expect(e.db.all<{ id: string }>('SELECT id FROM activity_events WHERE id LIKE ?', 'a-%').map((r) => r.id)).toEqual(['a-new']);
    expect(e.db.all<{ id: string }>('SELECT id FROM process_runs').map((r) => r.id)).toEqual(['p-new']);
    expect(e.db.all<{ id: string }>('SELECT id FROM usage_log').map((r) => r.id)).toEqual(['u-new']);
  });

  it('never delete work that is still going: a running process and a running request stay, however old', async () => {
    const e = await env();
    e.put.process('p-run', 'running', daysAgo(100), null);
    e.put.usage('u-run', 'running', daysAgo(100));
    e.retention.prune();
    expect(e.count('process_runs')).toBe(1);
    expect(e.count('usage_log')).toBe(1);
  });

  it('keep everything when a limit is 0', async () => {
    const e = await env({ activityDays: 0, processRunDays: 0, sessionDays: 0, usageDays: 0 });
    e.put.activity('a-ancient', daysAgo(5000));
    e.put.process('p-ancient', 'exited', daysAgo(5000), daysAgo(5000));
    e.put.usage('u-ancient', 'completed', daysAgo(5000));
    expect(e.retention.prune()).toEqual({ activity: 0, processRuns: 0, sessions: 0, usage: 0, logFiles: 0 });
    expect(e.count('process_runs')).toBe(1);
    expect(e.count('usage_log')).toBe(1);
  });

  it('remove rotated log files beyond the count, keep the current one and files that are not logs, and use the setting at once', async () => {
    const e = await env({ logFiles: 2 });
    expect(e.retention.prune().logFiles).toBe(3);
    for (const name of ['main.log', 'main.1.log', 'main.2.log', 'other.txt']) expect(existsSync(join(e.logDir, name)), name).toBe(true);
    for (const name of ['main.3.log', 'main.4.log', 'main.5.log']) expect(existsSync(join(e.logDir, name)), name).toBe(false);
    e.settings.logFiles = 1;
    expect(e.retention.prune().logFiles).toBe(1);
    expect(existsSync(join(e.logDir, 'main.2.log'))).toBe(false);
  });

  it('say what they removed in the activity list, and say nothing when there was nothing to remove', async () => {
    const e = await env({ logFiles: 2 });
    e.retention.prune();
    expect(e.activity.list({ kinds: ['retention.pruned'], limit: 5 })).toHaveLength(1); // the three extra log files of the fixture
    e.retention.prune();
    expect(e.activity.list({ kinds: ['retention.pruned'], limit: 5 })).toHaveLength(1);
  });

  it('start and stop: it prunes at start and does not keep a timer after stop', async () => {
    const e = await env();
    e.put.activity('a-old', daysAgo(400));
    e.retention.start();
    expect(e.db.all('SELECT id FROM activity_events WHERE id = ?', 'a-old')).toEqual([]);
    e.retention.stop();
    e.retention.stop(); // stopping twice is fine
  });
});
