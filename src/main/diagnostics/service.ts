import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActivityEvent, ActivityFilter } from '@shared/activity';
import { LOG_LEVEL_NAMES, type LogEntry, type LogsResult } from '@shared/diagnostics';
import { AppError } from '@shared/errors';
import type { ProviderStatus } from '@shared/providers';
import type { ResourceSnapshot } from '@shared/resources';
import type { Settings } from '@shared/settings';
import type { ActivityLog, Redactor } from '../logging';
import type { Db } from '../storage';

// Reading the app's own history out of the app (spec §15, §22, §27.8): a filtered activity export, a view of the log file, and one
// diagnostics bundle for bug reports. Every file goes through the redactor and is written where the person chose in a native save
// window; the page never names a path.

export interface DiagnosticsOptions {
  db: Db;
  activity: ActivityLog;
  redactor: Redactor;
  /** The folder of main.log and its rotated files. */
  logDir: string;
  appInfo: () => Record<string, unknown>;
  settings: () => Settings;
  providers: () => Promise<ProviderStatus[]>;
  resources: () => ResourceSnapshot | undefined;
  /** A native save window. Returns undefined when the person cancels. */
  chooseFile: (options: { defaultName: string; kind: 'json' | 'csv' }) => Promise<string | undefined>;
  now?: () => Date;
}

export interface DiagnosticsService {
  exportActivity(filter: Omit<ActivityFilter, 'limit' | 'before'>, format: 'json' | 'csv'): Promise<{ saved: boolean; count: number }>;
  logs(options: { lines: number; level?: (typeof LOG_LEVEL_NAMES)[number] | undefined; search?: string | undefined }): LogsResult;
  bundle(): Promise<{ saved: boolean; count: number }>;
}

const RANK = { error: 0, warn: 1, info: 2, debug: 3 } as const;
const MAX_EXPORT = 50_000;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const csvCell = (value: unknown): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  // A cell that starts like a formula would run in a spreadsheet; a leading apostrophe makes it plain text.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function createDiagnosticsService(options: DiagnosticsOptions): DiagnosticsService {
  const { db, activity, redactor } = options;
  const now = options.now ?? (() => new Date());
  const stamp = (): string => now().toISOString().replace(/[:T]/g, '-').slice(0, 19);

  /** The log files, newest first: main.log, then main.1.log, main.2.log, ... */
  const logFiles = (): { name: string; path: string; bytes: number }[] =>
    existsSync(options.logDir)
      ? readdirSync(options.logDir)
          .filter((name) => /^main(\.\d+)?\.log$/.test(name))
          .map((name) => ({ name, path: join(options.logDir, name), bytes: statSync(join(options.logDir, name)).size, order: name === 'main.log' ? 0 : Number(/\.(\d+)\./.exec(name)?.[1] ?? 99) }))
          .sort((a, b) => a.order - b.order)
      : [];

  const readLogs = (lines: number, level: keyof typeof RANK | undefined, search: string | undefined): LogsResult => {
    const files = logFiles();
    const entries: LogEntry[] = [];
    const needle = search?.trim().toLowerCase();
    // newest lines first: walk the files from newest to oldest, each from its end
    for (const file of files) {
      const rows = readFileSync(file.path, 'utf8').split(/\r?\n/).filter(Boolean).reverse();
      for (const row of rows) {
        let parsed: { t?: unknown; lvl?: unknown; mod?: unknown; msg?: unknown; data?: unknown };
        try {
          parsed = JSON.parse(row) as typeof parsed;
        } catch {
          continue; // a damaged line (a crash mid-write) is skipped, not shown as if it were an entry
        }
        const lvl = LOG_LEVEL_NAMES.find((l) => l === parsed.lvl);
        if (lvl === undefined) continue;
        if (level !== undefined && RANK[lvl] > RANK[level]) continue;
        const entry: LogEntry = {
          at: str(parsed.t).slice(0, 40),
          level: lvl,
          module: str(parsed.mod).slice(0, 120),
          message: redactor.redact(str(parsed.msg)).slice(0, 1000),
          // redacted as a value first: once it is JSON text its backslashes are doubled and the user's folder would no longer match
          data: parsed.data === undefined ? '' : redactor.redact(JSON.stringify(redactor.redactValue(parsed.data))).slice(0, 2000),
        };
        if (needle !== undefined && needle !== '' && !`${entry.module} ${entry.message} ${entry.data}`.toLowerCase().includes(needle)) continue;
        entries.push(entry);
        if (entries.length >= lines) return { entries, files: files.map((f) => ({ name: f.name, bytes: f.bytes })) };
      }
    }
    return { entries, files: files.map((f) => ({ name: f.name, bytes: f.bytes })) };
  };

  const write = (path: string, text: string): void => {
    try {
      writeFileSync(path, text, 'utf8');
    } catch (error) {
      throw new AppError('INTERNAL', 'The file could not be saved.', { cause: error, hint: 'Choose another folder, or check that the disk has room.' });
    }
  };

  return {
    async exportActivity(filter, format) {
      const path = await options.chooseFile({ defaultName: `activity-${stamp()}.${format}`, kind: format });
      if (path === undefined) return { saved: false, count: 0 };
      const events: ActivityEvent[] = [];
      let before: string | undefined;
      // pages of 500, newest first, until the filter runs out or the cap is reached
      for (;;) {
        const page = activity.list({ ...filter, ...(before === undefined ? {} : { before }), limit: 500 });
        events.push(...page);
        if (page.length < 500 || events.length >= MAX_EXPORT) break;
        before = page.at(-1)?.occurredAt;
        if (before === undefined) break;
      }
      const rows = events.slice(0, MAX_EXPORT);
      if (format === 'json') write(path, JSON.stringify({ format: 'gdcc-activity', exportedAt: now().toISOString(), count: rows.length, events: redactor.redactValue(rows) }, null, 2));
      else {
        const header = ['time', 'severity', 'kind', 'summary', 'project', 'task', 'details'];
        const lines = rows.map((e) => [e.occurredAt, e.severity, e.kind, redactor.redact(e.summary), e.projectId ?? '', e.taskId ?? '', e.details === undefined ? '' : redactor.redact(JSON.stringify(e.details))].map(csvCell).join(','));
        write(path, `${header.join(',')}\r\n${lines.join('\r\n')}\r\n`);
      }
      return { saved: true, count: rows.length };
    },

    logs: ({ lines, level, search }) => readLogs(lines, level, search),

    async bundle() {
      const path = await options.chooseFile({ defaultName: `diagnostics-${stamp()}.json`, kind: 'json' });
      if (path === undefined) return { saved: false, count: 0 };
      const providers = (await options.providers()).map((p) => ({ id: p.id, status: p.status, version: p.version, message: p.message, checkedAt: p.checkedAt }));
      const counts = Object.fromEntries(
        ['activity_events', 'process_runs', 'usage_log', 'agent_runs', 'change_sessions', 'projects', 'tasks'].map((table) => [table, db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0]),
      );
      const processRuns = db.all<Record<string, unknown>>('SELECT owner_kind, purpose, status, exit_code, started_at, ended_at FROM process_runs ORDER BY started_at DESC LIMIT 100');
      const problems = activity.list({ severities: ['warning', 'error'], limit: 200 });
      const logs = readLogs(300, undefined, undefined);
      const bundle = {
        format: 'gdcc-diagnostics',
        createdAt: now().toISOString(),
        note: 'Secrets and your user folder name are removed. Project files and prompts are not included.',
        app: options.appInfo(),
        settings: options.settings(),
        providers,
        rowCounts: counts,
        resources: options.resources() ?? null,
        recentProblems: problems,
        recentProcesses: processRuns,
        logFiles: logs.files,
        recentLog: logs.entries,
      };
      write(path, JSON.stringify(redactor.redactValue(bundle), null, 2));
      return { saved: true, count: logs.entries.length + problems.length };
    },
  };
}
