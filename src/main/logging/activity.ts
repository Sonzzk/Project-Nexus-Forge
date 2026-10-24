import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ACTIVITY_SEVERITIES, type ActivityEvent, type ActivityFilter } from '@shared/activity';
import type { Db } from '../storage';
import type { Logger } from './logger';
import type { Redactor } from './redactor';

// The user-facing history (ARCHITECTURE.md section 11). `record` is the `recordActivity` API every feature step calls:
// it redacts, stores in `activity_events`, and tells the window.

export interface ActivityLog {
  record(event: Omit<ActivityEvent, 'id' | 'occurredAt'>): ActivityEvent;
  list(filter: ActivityFilter): ActivityEvent[];
}

export interface ActivityLogOptions {
  db: Db;
  redactor: Redactor;
  logger: Logger;
  /** Called after each stored event; main wires it to `webContents.send('activity:appended', event)`. */
  emit?: (event: ActivityEvent) => void;
  now?: () => Date;
  newId?: () => string;
}

interface Row {
  id: string;
  occurred_at: string;
  kind: string;
  severity: string;
  summary: string;
  project_id: string | null;
  task_id: string | null;
  details_json: string | null;
}

const DetailsSchema = z.record(z.string(), z.unknown());

export function createActivityLog(options: ActivityLogOptions): ActivityLog {
  const { db, redactor, logger } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;

  const toEvent = (row: Row): ActivityEvent => {
    const event: ActivityEvent = {
      id: row.id,
      occurredAt: row.occurred_at,
      kind: row.kind,
      severity: ACTIVITY_SEVERITIES.find((s) => s === row.severity) ?? 'info',
      summary: row.summary,
    };
    if (row.project_id !== null) event.projectId = row.project_id;
    if (row.task_id !== null) event.taskId = row.task_id;
    if (row.details_json !== null) {
      // A row whose details fail validation is reported, not silently dropped.
      let details: unknown;
      try {
        details = JSON.parse(row.details_json);
      } catch {
        details = undefined;
      }
      const parsed = DetailsSchema.safeParse(details);
      if (parsed.success) event.details = parsed.data;
      else logger.warn('activity event has unreadable details', { id: row.id, kind: row.kind });
    }
    return event;
  };

  return {
    record(input) {
      const event = redactor.redactValue<ActivityEvent>({
        ...input,
        id: newId(),
        occurredAt: now().toISOString(),
      });
      db.run(
        'INSERT INTO activity_events (id, occurred_at, kind, severity, summary, project_id, task_id, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        event.id,
        event.occurredAt,
        event.kind,
        event.severity,
        event.summary,
        event.projectId ?? null,
        event.taskId ?? null,
        event.details === undefined ? null : JSON.stringify(event.details),
      );
      try {
        options.emit?.(event);
      } catch (error) {
        logger.warn('activity listener failed', { error });
      }
      return event;
    },

    list(filter) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (filter.projectId !== undefined) {
        where.push('project_id = ?');
        params.push(filter.projectId);
      }
      if (filter.kinds !== undefined && filter.kinds.length > 0) {
        where.push(`kind IN (${filter.kinds.map(() => '?').join(', ')})`);
        params.push(...filter.kinds);
      }
      if (filter.before !== undefined) {
        where.push('occurred_at < ?');
        params.push(filter.before);
      }
      const sql = `SELECT id, occurred_at, kind, severity, summary, project_id, task_id, details_json FROM activity_events${
        where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
      } ORDER BY occurred_at DESC, rowid DESC LIMIT ?`;
      return db.all<Row>(sql, ...params, filter.limit).map(toEvent);
    },
  };
}
