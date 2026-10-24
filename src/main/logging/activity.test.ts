import { afterEach, describe, expect, it } from 'vitest';
import type { ActivityEvent } from '@shared/activity';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { removeTempDirs } from '../../../test/helpers/temp';
import { createActivityLog } from './activity';
import { createRedactor } from './redactor';

afterEach(removeTempDirs);

async function setup(emit?: (event: ActivityEvent) => void) {
  const { db } = await openMigratedDb();
  let tick = 0;
  const logger = memoryLogger();
  const log = createActivityLog({
    db,
    redactor: createRedactor({ homeDir: 'C:\\Users\\Amos Remahl' }),
    logger,
    now: () => new Date(Date.UTC(2026, 9, 24, 1, 0, tick++)),
    newId: () => `id-${tick}`,
    ...(emit === undefined ? {} : { emit }),
  });
  return { db, log, logger };
}

describe('ActivityLog', () => {
  it('stores an event with id and time, returns it and emits it', async () => {
    const emitted: ActivityEvent[] = [];
    const { db, log } = await setup((event) => emitted.push(event));
    const event = log.record({
      kind: 'app.started',
      severity: 'info',
      summary: 'Started',
      details: { version: '1' },
    });
    expect(event).toEqual({
      id: 'id-0',
      occurredAt: '2026-10-24T01:00:00.000Z',
      kind: 'app.started',
      severity: 'info',
      summary: 'Started',
      details: { version: '1' },
    });
    expect(emitted).toEqual([event]);
    expect(log.list({ limit: 10 })).toEqual([event]);
    db.close();
  });

  it('redacts the summary and the details before storing, emitting and returning', async () => {
    const emitted: ActivityEvent[] = [];
    const { db, log } = await setup((event) => emitted.push(event));
    log.record({
      kind: 'x',
      severity: 'warning',
      summary: 'Opened C:\\Users\\Amos Remahl\\game with token=abc123456',
      details: { apiKey: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', note: 'password=hunter2' },
    });
    const raw = JSON.stringify(db.all('SELECT * FROM activity_events'));
    expect(raw).not.toContain('abc123456');
    expect(raw).not.toContain('AbCdEf');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('Amos Remahl');
    expect(JSON.stringify(emitted)).not.toContain('hunter2');
    db.close();
  });

  it('lists newest first and filters by project, kind and time, with a limit', async () => {
    const { db, log } = await setup();
    log.record({ kind: 'a', severity: 'info', summary: 's1', projectId: 'p1' });
    log.record({ kind: 'b', severity: 'info', summary: 's2', projectId: 'p2' });
    log.record({ kind: 'a', severity: 'error', summary: 's3', projectId: 'p1' });
    log.record({ kind: 'c', severity: 'info', summary: 's4' });
    expect(log.list({ limit: 10 }).map((e) => e.summary)).toEqual(['s4', 's3', 's2', 's1']);
    expect(log.list({ limit: 2 }).map((e) => e.summary)).toEqual(['s4', 's3']);
    expect(log.list({ projectId: 'p1', limit: 10 }).map((e) => e.summary)).toEqual(['s3', 's1']);
    expect(log.list({ kinds: ['a', 'c'], limit: 10 }).map((e) => e.summary)).toEqual(['s4', 's3', 's1']);
    expect(log.list({ before: '2026-10-24T01:00:02.000Z', limit: 10 }).map((e) => e.summary)).toEqual([
      's2',
      's1',
    ]);
    db.close();
  });

  it('keeps storing when a listener throws', async () => {
    const { db, log, logger } = await setup(() => {
      throw new Error('window gone');
    });
    expect(() => log.record({ kind: 'a', severity: 'info', summary: 's' })).not.toThrow();
    expect(log.list({ limit: 5 })).toHaveLength(1);
    expect(logger.entries.some((e) => e.msg === 'activity listener failed')).toBe(true);
    db.close();
  });

  it('reports an event with unreadable details instead of dropping it', async () => {
    const { db, log, logger } = await setup();
    db.run(
      "INSERT INTO activity_events (id, occurred_at, kind, severity, summary, details_json) VALUES ('bad', '2026-10-24T00:00:00.000Z', 'k', 'info', 'broken', '[1,2]')",
    );
    const events = log.list({ limit: 5 });
    expect(events.map((e) => e.id)).toEqual(['bad']);
    expect(events[0]?.details).toBeUndefined();
    expect(logger.entries.some((e) => e.msg === 'activity event has unreadable details')).toBe(true);
    db.close();
  });

  it('survives a restart', async () => {
    const { db, dir } = await openMigratedDb();
    createActivityLog({ db, redactor: createRedactor(), logger: memoryLogger() }).record({
      kind: 'k',
      severity: 'info',
      summary: 'kept',
    });
    db.close();
    const again = await openMigratedDb(dir);
    expect(
      createActivityLog({ db: again.db, redactor: createRedactor(), logger: memoryLogger() }).list({
        limit: 5,
      })[0]?.summary,
    ).toBe('kept');
    again.db.close();
  });
});
