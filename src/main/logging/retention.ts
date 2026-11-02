import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../storage';
import type { ActivityLog } from './activity';
import type { Logger } from './logger';

// Retention limits (spec §22): history does not grow without end. Activity events, finished process records, session records and
// the usage log older than the configured number of days are deleted (0 keeps everything), and rotated log files beyond the
// configured count are removed. Nothing the person is still waiting on is touched: running processes, running requests and open
// review sessions are never deleted, whatever their age. The prune runs at start and then once a day.

export interface RetentionSettings {
  activityDays: number;
  processRunDays: number;
  sessionDays: number;
  usageDays: number;
  /** Rotated log files kept next to main.log. */
  logFiles: number;
}

export interface RetentionResult {
  activity: number;
  processRuns: number;
  sessions: number;
  usage: number;
  logFiles: number;
}

export interface Retention {
  prune(): RetentionResult;
  start(): void;
  stop(): void;
}

export interface RetentionOptions {
  db: Db;
  activity: ActivityLog;
  logger: Logger;
  logDir: string;
  settings: () => RetentionSettings;
  now?: () => Date;
  /** How often the prune repeats. */
  everyMs?: number;
}

const DAY_MS = 24 * 3600 * 1000;

export function createRetention(options: RetentionOptions): Retention {
  const { db, activity, logger } = options;
  const now = options.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;

  const cutoff = (days: number): string => new Date(now().getTime() - days * DAY_MS).toISOString();

  const prune = (): RetentionResult => {
    const s = options.settings();
    const result: RetentionResult = { activity: 0, processRuns: 0, sessions: 0, usage: 0, logFiles: 0 };
    if (s.activityDays > 0) result.activity = db.run('DELETE FROM activity_events WHERE occurred_at < ?', cutoff(s.activityDays)).changes;
    if (s.processRunDays > 0) result.processRuns = db.run("DELETE FROM process_runs WHERE status != 'running' AND COALESCE(ended_at, started_at) < ?", cutoff(s.processRunDays)).changes;
    if (s.sessionDays > 0) result.sessions = db.run("DELETE FROM run_sessions WHERE outcome != 'running' AND COALESCE(ended_at, started_at) < ?", cutoff(s.sessionDays)).changes;
    if (s.usageDays > 0) result.usage = db.run("DELETE FROM usage_log WHERE status != 'running' AND started_at < ?", cutoff(s.usageDays)).changes;
    if (existsSync(options.logDir)) {
      for (const name of readdirSync(options.logDir)) {
        const n = /^main\.(\d+)\.log$/.exec(name)?.[1];
        if (n !== undefined && Number(n) > s.logFiles) {
          rmSync(join(options.logDir, name), { force: true });
          result.logFiles++;
        }
      }
    }
    const removed = result.activity + result.processRuns + result.sessions + result.usage + result.logFiles;
    if (removed > 0) {
      logger.info('old history was removed under the retention limits', { ...result });
      // recorded after the deletion, so the note itself is never the first thing pruned
      activity.record({ kind: 'retention.pruned', severity: 'info', summary: `Removed old history under the retention limits: ${result.activity} activity entries, ${result.processRuns} process records, ${result.sessions} session records, ${result.usage} usage rows, ${result.logFiles} old log files.`, details: { ...result } });
    }
    return result;
  };

  return {
    prune,
    start() {
      if (timer !== undefined) return;
      try {
        prune();
      } catch (error) {
        logger.warn('the retention prune failed', { error });
      }
      timer = setInterval(() => {
        try {
          prune();
        } catch (error) {
          logger.warn('the retention prune failed', { error });
        }
      }, options.everyMs ?? DAY_MS);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
