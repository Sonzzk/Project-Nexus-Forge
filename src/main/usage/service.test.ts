import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { removeTempDirs } from '../../../test/helpers/temp';
import { copyFixture } from '../../../test/helpers/tree';
import { createActivityLog, createRedactor } from '../logging';
import { createProjectRegistry } from '../projects';
import { createTaskService } from '../planning';
import { createUsageService, type LaunchContext, type LimitSettings } from './service';

afterEach(removeTempDirs);

async function env(initial: Partial<LimitSettings> = {}) {
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const activity = createActivityLog({ db, redactor: createRedactor(), logger });
  const projects = createProjectRegistry({ db, activity, logger });
  const project = projects.add(copyFixture('audit-godot'));
  const other = projects.add(copyFixture('audit-node'));
  const tasks = createTaskService({ db, projects, activity, requirePlanApproval: () => false });
  const task = tasks.create({ projectId: project.id, title: 'Crouch', description: '', provider: '', complexity: 'm', priority: 'normal' });
  const limits: LimitSettings = { perDay: 0, perProjectPerDay: 0, perTask: 0, maxAttempts: 3, ...initial };
  const clock = { at: new Date(2026, 9, 24, 12, 0, 0) }; // local time, so "today" is the 24th wherever the test runs
  const usage = createUsageService({ db, activity, limits: () => limits, now: () => (clock.at = new Date(clock.at.getTime() + 1)) }); // each reading is a millisecond later, so the newest row is always last
  const cloud = (extra: Partial<LaunchContext> = {}): LaunchContext => ({ provider: 'claude-code', purpose: 'agent-run', model: '', location: 'cloud', projectId: project.id, ...extra });
  /** A finished cloud launch, as the provider service writes it. */
  const send = (extra: Partial<LaunchContext> = {}) => {
    const context = cloud(extra);
    usage.enforce(context);
    const id = usage.begin(context);
    usage.finish(id, { status: 'completed' });
    return id;
  };
  return { db, activity, project, other, task, tasks, limits, clock, usage, cloud, send };
}

const failure = (run: () => unknown): AppError => {
  try {
    run();
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a failure');
};

describe('the usage log', () => {
  it('stores usage only when the provider returned it: missing stays empty, never zero', async () => {
    const e = await env();
    const reported = e.usage.begin(e.cloud({ model: 'sonnet' }));
    e.usage.finish(reported, { status: 'completed', usage: { inputCount: 120, outputCount: 45, costUsdEstimate: 0.0123 } });
    const silent = e.usage.begin(e.cloud({ provider: 'codex' }));
    e.usage.finish(silent, { status: 'completed', usage: null });
    const partial = e.usage.begin(e.cloud());
    e.usage.finish(partial, { status: 'completed', usage: { inputCount: 7, outputCount: null, costUsdEstimate: null } });

    const rows = e.usage.list({ limit: 10 });
    const byId = (id: string) => rows.find((r) => r.id === id);
    expect(byId(reported)).toMatchObject({ model: 'sonnet', status: 'completed', inputCount: 120, outputCount: 45, costUsdEstimate: 0.0123 });
    expect(byId(silent)).toMatchObject({ inputCount: null, outputCount: null, costUsdEstimate: null });
    expect(byId(partial)).toMatchObject({ inputCount: 7, outputCount: null, costUsdEstimate: null });
  });

  it('totals cover only the runs that reported, and say how many did not', async () => {
    const e = await env();
    const a = e.usage.begin(e.cloud());
    e.usage.finish(a, { status: 'completed', usage: { inputCount: 100, outputCount: 10, costUsdEstimate: 0.5 } });
    const b = e.usage.begin(e.cloud());
    e.usage.finish(b, { status: 'completed', usage: { inputCount: 50, outputCount: 5, costUsdEstimate: 0.25 } });
    const c = e.usage.begin(e.cloud({ provider: 'codex' }));
    e.usage.finish(c, { status: 'failed', reason: 'not signed in' });
    const today = e.usage.summary().today;
    expect(today).toMatchObject({ launches: 3, cloudLaunches: 3, reported: 2, unreported: 1, inputCount: 150, outputCount: 15, costUsdEstimate: 0.75 });
  });

  it('an empty log reports no numbers at all, not zeros', async () => {
    const e = await env();
    expect(e.usage.summary().today).toEqual({ launches: 0, cloudLaunches: 0, blocked: 0, reported: 0, unreported: 0, inputCount: null, outputCount: null, costUsdEstimate: null });
  });

  it('keeps the project and task names for display and keeps the row if they are deleted', async () => {
    const e = await env();
    const id = e.send({ taskId: e.task.id, runId: 'run-1' });
    expect(e.usage.list({ limit: 5 })[0]).toMatchObject({ id, projectName: e.project.name, taskTitle: 'Crouch', runId: 'run-1' });
    e.tasks.remove(e.task.id);
    expect(e.usage.list({ limit: 5 })[0]).toMatchObject({ id, taskId: null, taskTitle: null });
  });

  it('lists newest first, for one project or for all', async () => {
    const e = await env();
    e.send();
    e.clock.at = new Date(2026, 9, 24, 13, 0, 0);
    const later = e.send({ projectId: e.other.id });
    expect(e.usage.list({ limit: 10 }).map((r) => r.id)[0]).toBe(later);
    expect(e.usage.list({ projectId: e.project.id, limit: 10 })).toHaveLength(1);
    expect(e.usage.list({ limit: 1 })).toHaveLength(1);
  });

  it('marks a request that was running when the app stopped as interrupted, with its usage unknown', async () => {
    const e = await env();
    const id = e.usage.begin(e.cloud());
    expect(e.usage.recover()).toBe(1);
    expect(e.usage.list({ limit: 5 })[0]).toMatchObject({ id, status: 'interrupted', inputCount: null });
    expect(e.usage.recover()).toBe(0);
  });
});

describe('launch limits', () => {
  it('stop the launch that would pass the daily limit, say why, record it and tell the activity list', async () => {
    const e = await env({ perDay: 2 });
    e.send();
    e.send();
    const error = failure(() => e.usage.enforce(e.cloud()));
    expect(error).toMatchObject({ code: 'LIMIT_REACHED' });
    expect(error.message).toContain('daily limit of 2');
    expect(error.hint).toContain('Nothing was sent');
    const [blocked] = e.usage.list({ limit: 1 });
    expect(blocked).toMatchObject({ status: 'blocked', reason: expect.stringContaining('daily limit') as string });
    expect(e.activity.list({ kinds: ['usage.blocked'], limit: 10 })).toHaveLength(1);
  });

  it('count launches, not blocked attempts: a blocked launch never uses up a limit', async () => {
    const e = await env({ perDay: 1 });
    e.send();
    for (let i = 0; i < 3; i++) failure(() => e.usage.enforce(e.cloud()));
    expect(e.usage.summary().limits.perDay).toEqual({ limit: 1, used: 1 });
    expect(e.usage.summary().today).toMatchObject({ launches: 1, blocked: 3 });
  });

  it('count a failed or cancelled launch, because it was sent', async () => {
    const e = await env({ perDay: 2 });
    const a = e.usage.begin(e.cloud());
    e.usage.finish(a, { status: 'failed', reason: 'timeout' });
    const b = e.usage.begin(e.cloud());
    e.usage.finish(b, { status: 'cancelled' });
    expect(failure(() => e.usage.enforce(e.cloud())).code).toBe('LIMIT_REACHED');
  });

  it('never limit a local model, and never count it against the cloud limits', async () => {
    const e = await env({ perDay: 1 });
    for (let i = 0; i < 3; i++) {
      const local = e.cloud({ provider: 'ollama', location: 'local' });
      e.usage.enforce(local);
      e.usage.finish(e.usage.begin(local), { status: 'completed', usage: { inputCount: 4, outputCount: 2, costUsdEstimate: null } });
    }
    e.send();
    expect(e.usage.summary().today).toMatchObject({ launches: 4, cloudLaunches: 1 });
    expect(failure(() => e.usage.enforce(e.cloud())).code).toBe('LIMIT_REACHED');
  });

  it('apply per project each day', async () => {
    const e = await env({ perProjectPerDay: 1 });
    e.send();
    expect(failure(() => e.usage.enforce(e.cloud())).message).toContain('This project');
    e.send({ projectId: e.other.id });
    expect(e.usage.summary(e.project.id).limits.perProject).toEqual({ limit: 1, used: 1 });
    expect(e.usage.summary().limits.perProject).toBeNull();
  });

  it('apply per task over its whole life', async () => {
    const e = await env({ perTask: 2 });
    e.send({ taskId: e.task.id });
    e.clock.at = new Date(2026, 9, 26, 9, 0, 0); // two days later: a per-task limit does not reset
    e.send({ taskId: e.task.id });
    expect(failure(() => e.usage.enforce(e.cloud({ taskId: e.task.id }))).message).toContain('This task');
    e.usage.enforce(e.cloud()); // another task, or none, is unaffected
  });

  it('reset at local midnight', async () => {
    const e = await env({ perDay: 1 });
    e.clock.at = new Date(2026, 9, 24, 23, 59, 0);
    e.send();
    failure(() => e.usage.enforce(e.cloud()));
    e.clock.at = new Date(2026, 9, 25, 0, 1, 0);
    e.usage.enforce(e.cloud());
    expect(e.usage.summary().limits.perDay).toEqual({ limit: 1, used: 0 });
  });

  it('are off at 0, and read the settings each time so a change applies at once', async () => {
    const e = await env({ perDay: 0, perProjectPerDay: 0, perTask: 0 });
    for (let i = 0; i < 5; i++) e.send({ taskId: e.task.id });
    e.limits.perDay = 5;
    failure(() => e.usage.enforce(e.cloud()));
    e.limits.perDay = 6;
    e.usage.enforce(e.cloud());
  });

  it('report the attempt limit of the routing settings next to the launch limits', async () => {
    const e = await env({ maxAttempts: 2 });
    expect(e.usage.summary().limits).toMatchObject({ maxAttempts: 2, perTaskLimit: 0 });
  });
});
