import { randomUUID } from 'node:crypto';
import { AppError } from '@shared/errors';
import { PROVIDER_IDS, PROVIDER_LABELS, type GeneratePurpose, type ProviderId, type Usage } from '@shared/providers';
import type { LimitState, UsageRow, UsageStatus, UsageSummary, UsageWindow } from '@shared/usage';
import type { ActivityLog } from '../logging';
import type { Db } from '../storage';

// The usage log and launch limits (spec §12). The log records what was sent and what the provider said about it; nothing is
// estimated here. Limits count cloud launches (anything that leaves this PC) and are enforced before a request is sent, so the
// person is never asked to approve something a limit will stop. The app cannot see a provider's own quota, so these counts are
// a safeguard on how often the app launches, not a meter of what the provider charges.

export interface LaunchContext {
  provider: ProviderId;
  purpose: GeneratePurpose;
  model: string;
  /** `cloud` for anything that leaves this PC. */
  location: 'local' | 'cloud';
  projectId?: string | undefined;
  taskId?: string | undefined;
  runId?: string | undefined;
}

export interface LimitSettings {
  /** 0 turns a limit off. */
  perDay: number;
  perProjectPerDay: number;
  perTask: number;
  maxAttempts: number;
}

export interface UsageServiceOptions {
  db: Db;
  activity: ActivityLog;
  limits: () => LimitSettings;
  now?: () => Date;
  newId?: () => string;
}

export interface UsageService {
  /** Throws LIMIT_REACHED (and records the block) when this launch would pass a limit. Local requests are never limited. */
  enforce(context: LaunchContext): void;
  /** Writes the row for a request that is about to be sent. */
  begin(context: LaunchContext): string;
  /** Closes the row. `usage` is stored only if the provider returned it. */
  finish(id: string, outcome: { status: Exclude<UsageStatus, 'running' | 'blocked'>; usage?: Usage | null; reason?: string }): void;
  summary(projectId?: string): UsageSummary;
  list(options: { projectId?: string | undefined; limit: number }): UsageRow[];
  /** At startup: requests that were running when the app stopped are marked interrupted; their usage is unknown. */
  recover(): number;
}

interface Row {
  id: string;
  project_id: string | null;
  project_name: string | null;
  task_id: string | null;
  task_title: string | null;
  run_id: string | null;
  purpose: GeneratePurpose;
  provider_id: ProviderId;
  model: string;
  location: 'local' | 'cloud';
  status: UsageStatus;
  started_at: string;
  ended_at: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  reason: string;
}

const SENT = "status != 'blocked'";

const fromRow = (r: Row): UsageRow => ({
  id: r.id,
  projectId: r.project_id,
  projectName: r.project_name,
  taskId: r.task_id,
  taskTitle: r.task_title,
  runId: r.run_id,
  purpose: r.purpose,
  provider: r.provider_id,
  model: r.model,
  location: r.location,
  status: r.status,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  inputCount: r.input_tokens,
  outputCount: r.output_tokens,
  costUsdEstimate: r.cost_usd,
  reason: r.reason,
});

export function createUsageService(options: UsageServiceOptions): UsageService {
  const { db, activity } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;

  /** Local midnight, so "per day" means the person's calendar day. */
  const dayStart = (): string => {
    const d = now();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
  };
  const count = (where: string, ...params: string[]): number => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM usage_log WHERE location = 'cloud' AND ${SENT} AND ${where}`, ...params)?.n ?? 0;

  /** The first limit this launch would pass, in plain words; undefined when it is within all of them. */
  function exceeded(context: LaunchContext): string | undefined {
    const limits = options.limits();
    const since = dayStart();
    const label = PROVIDER_LABELS[context.provider];
    if (limits.perDay > 0 && count('started_at >= ?', since) >= limits.perDay)
      return `The daily limit of ${limits.perDay} cloud launches is used up (${label} was not started).`;
    if (limits.perProjectPerDay > 0 && context.projectId !== undefined && count('project_id = ? AND started_at >= ?', context.projectId, since) >= limits.perProjectPerDay)
      return `This project has already used its limit of ${limits.perProjectPerDay} cloud launches today.`;
    if (limits.perTask > 0 && context.taskId !== undefined && count('task_id = ?', context.taskId) >= limits.perTask)
      return `This task has already used its limit of ${limits.perTask} cloud launches.`;
    return undefined;
  }

  const insert = (context: LaunchContext, status: UsageStatus, reason: string): string => {
    const id = newId();
    const stamp = now().toISOString();
    db.run(
      `INSERT INTO usage_log (id, project_id, task_id, run_id, purpose, provider_id, model, location, status, started_at, ended_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, context.projectId ?? null, context.taskId ?? null, context.runId ?? null, context.purpose, context.provider, context.model, context.location, status, stamp, status === 'blocked' ? stamp : null, reason.slice(0, 600),
    );
    return id;
  };

  const window = (where: string, ...params: string[]): UsageWindow => {
    const row = db.get<{ launches: number; cloud: number; blocked: number; reported: number; input: number | null; output: number | null; cost: number | null }>(
      `SELECT SUM(status != 'blocked') AS launches,
              SUM(status != 'blocked' AND location = 'cloud') AS cloud,
              SUM(status = 'blocked') AS blocked,
              SUM(status != 'blocked' AND status != 'running' AND (input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cost_usd IS NOT NULL)) AS reported,
              SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_usd) AS cost
         FROM usage_log WHERE ${where}`,
      ...params,
    );
    const launches = row?.launches ?? 0;
    const finished = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM usage_log WHERE status NOT IN ('blocked', 'running') AND ${where}`, ...params)?.n ?? 0;
    const reported = row?.reported ?? 0;
    return { launches, cloudLaunches: row?.cloud ?? 0, blocked: row?.blocked ?? 0, reported, unreported: Math.max(0, finished - reported), inputCount: row?.input ?? null, outputCount: row?.output ?? null, costUsdEstimate: row?.cost ?? null };
  };

  return {
    enforce(context) {
      if (context.location === 'local') return;
      const reason = exceeded(context);
      if (reason === undefined) return;
      insert(context, 'blocked', reason);
      activity.record({
        kind: 'usage.blocked',
        severity: 'warning',
        summary: `A launch was stopped by a limit: ${reason}`.slice(0, 500),
        ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
        ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
        details: { provider: context.provider, purpose: context.purpose, runId: context.runId ?? null },
      });
      throw new AppError('LIMIT_REACHED', reason, { hint: 'Raise the limit on the Integrations page under Usage and limits, or wait for tomorrow. Nothing was sent.' });
    },

    begin: (context) => insert(context, 'running', ''),

    finish(id, outcome) {
      const usage = outcome.usage ?? null;
      db.run(
        'UPDATE usage_log SET status = ?, ended_at = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, reason = ? WHERE id = ?',
        outcome.status, now().toISOString(), usage?.inputCount ?? null, usage?.outputCount ?? null, usage?.costUsdEstimate ?? null, (outcome.reason ?? '').slice(0, 600), id,
      );
    },

    summary(projectId) {
      const limits = options.limits();
      const since = dayStart();
      const month = new Date(now().getTime() - 30 * 24 * 3600 * 1000).toISOString();
      const state = (limit: number, used: number): LimitState => ({ limit, used });
      const byProvider = PROVIDER_IDS.map((provider) => {
        const w = window('provider_id = ? AND started_at >= ?', provider, month);
        return { provider, launches: w.launches, reported: w.reported, unreported: w.unreported };
      }).filter((p) => p.launches > 0);
      return {
        today: window('started_at >= ?', since),
        last30Days: window('started_at >= ?', month),
        byProvider,
        limits: {
          perDay: state(limits.perDay, count('started_at >= ?', since)),
          perProject: projectId === undefined ? null : state(limits.perProjectPerDay, count('project_id = ? AND started_at >= ?', projectId, since)),
          perTaskLimit: limits.perTask,
          maxAttempts: limits.maxAttempts,
        },
        dayStartsAt: since,
      };
    },

    list({ projectId, limit }) {
      const rows = db.all<Row>(
        `SELECT u.id, u.project_id, p.name AS project_name, u.task_id, t.title AS task_title, u.run_id, u.purpose, u.provider_id, u.model, u.location, u.status,
                u.started_at, u.ended_at, u.input_tokens, u.output_tokens, u.cost_usd, u.reason
           FROM usage_log u LEFT JOIN projects p ON p.id = u.project_id LEFT JOIN tasks t ON t.id = u.task_id
          ${projectId === undefined ? '' : 'WHERE u.project_id = ?'} ORDER BY u.started_at DESC, u.id LIMIT ?`,
        ...(projectId === undefined ? [limit] : [projectId, limit]),
      );
      return rows.map(fromRow);
    },

    recover() {
      return db.run("UPDATE usage_log SET status = 'interrupted', ended_at = ?, reason = 'The app closed while this request was running, so how it ended and what it used are unknown.' WHERE status = 'running'", now().toISOString()).changes;
    },
  };
}
