import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '@shared/errors';
import type { ProviderId } from '@shared/providers';
import type { PolicyVerdict } from '@shared/resources';
import { availabilityFrom, type RoutingProfile } from '@shared/routing';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { createMockProvider, type MockProvider } from '../../../test/helpers/mock-provider';
import { closeOnCleanup, makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { copyFixture } from '../../../test/helpers/tree';
import { createActivityLog, createRedactor } from '../logging';
import { createProcessRunner, type ProcessRunner } from '../process';
import { createProjectRegistry } from '../projects';
import { createProviderService } from '../providers';
import { createAgentService } from './agents';
import { createRunQueue, type ExecuteRequest, type RunQueue } from './queue';
import { createTaskService } from './tasks';

const queues: RunQueue[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.shutdown()));
  removeTempDirs();
});

const allowed: PolicyVerdict = { allowed: true, blocks: [], warnings: [] };

interface Options {
  writesEnabled?: boolean;
  dir?: string;
  rootPath?: string;
  execute?: (request: ExecuteRequest) => Promise<{ sent: boolean; text: string; truncated: boolean }>;
}

async function env(options: Options = {}) {
  const { db, dir } = await openMigratedDb(options.dir);
  const logger = memoryLogger();
  const redactor = createRedactor();
  const activity = createActivityLog({ db, redactor, logger });
  const projects = createProjectRegistry({ db, activity, logger });
  const project = projects.list()[0] ?? projects.add(options.rootPath ?? copyFixture('audit-godot'));
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 24, 12, 0, 0, tick++));
  const tasks = createTaskService({ db, projects, activity, requirePlanApproval: () => false, now });
  const agents = createAgentService({ db, projects, tasks, activity, now });
  const adapters: Record<ProviderId, MockProvider> = { ollama: createMockProvider('ollama'), 'claude-code': createMockProvider('claude-code'), codex: createMockProvider('codex') };
  const confirms: string[] = [];
  const answers = { confirm: true };
  const confirm = (o: { title: string; message: string; detail?: string }): Promise<boolean> => {
    confirms.push(`${o.title}\n${o.message}\n${o.detail ?? ''}`);
    return Promise.resolve(answers.confirm);
  };
  const providers = createProviderService({ db, adapters, projects, activity, logger, redactor, confirm, progress: () => undefined, ollamaEndpoint: () => 'http://127.0.0.1:11434', env: () => ({}), sandboxDir: () => 'C:\\Data\\provider-sandbox', now });
  const routing = { profile: 'balanced' as RoutingProfile, overrides: {}, localModel: 'llama3.2:1b', maxAttempts: 3, apiKeySet: false };
  const policy = { verdict: allowed };
  const queue = createRunQueue({
    db, agents, tasks, projects, activity, logger, now, confirm,
    execute: options.execute ?? ((r) => providers.runAgent({ projectId: r.projectId, choice: { provider: r.provider, model: r.model }, prompt: r.prompt, note: r.note, signal: r.signal, onApproved: r.onApproved, ownerId: r.runId })),
    availability: async () => availabilityFrom(await providers.list()),
    providerBusy: (id) => providers.busy(id),
    routing: () => routing,
    localPolicy: () => Promise.resolve(policy.verdict),
    recheckMs: () => 20,
    writesEnabled: options.writesEnabled ?? false,
  });
  queues.push(queue);
  const newTask = (title: string, extra: { priority?: 'low' | 'normal' | 'high' | 'critical'; complexity?: 'xs' | 's' | 'm' | 'l' } = {}) =>
    tasks.create({ projectId: project.id, title, description: 'The player jumps.', provider: 'Claude Code', complexity: extra.complexity ?? 'l', priority: extra.priority ?? 'normal' });
  // The ids of the queued runs, in step order. shortcut: typed as five so tests can destructure; they only read what they queued.
  const runOf = (taskId: string, workflow: 'plan' | 'implement' | 'documentation' = 'plan', extra: { includeReviewer?: boolean } = {}) =>
    agents.createWorkflow({ taskId, workflow, includeReviewer: extra.includeReviewer ?? false, includeQa: false }).map((run) => run.id) as [string, string, string, string, string];
  return { db, dir, activity, projects, project, tasks, agents, adapters, providers, queue, confirms, answers, routing, policy, newTask, runOf };
}

const until = async (check: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const failure = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a failure');
};

describe('routing a run', () => {
  it('Balanced sends a large plan to Claude Code after a confirmation that names the route and its cost, and keeps the answer', async () => {
    const e = await env();
    const [run] = e.runOf(e.newTask('Add jumping').id);
    e.adapters['claude-code'].answer = 'Plan: 1. input 2. physics';
    const started = await e.queue.start(run);
    expect(started.route).toMatchObject({ provider: 'claude-code', profile: 'balanced', billing: 'subscription' });
    await until(() => e.agents.get(run).state === 'completed');
    expect(e.agents.get(run)).toMatchObject({ result: 'Plan: 1. input 2. physics', providerId: 'claude-code' });
    expect(e.confirms).toHaveLength(1);
    expect(e.confirms[0]).toMatch(/Routing \(Balanced\).*Cost: Counts against your Claude Code subscription/s);
    expect(e.confirms[0]).toContain('read-only');
    expect(e.adapters['claude-code'].requests[0]).toMatchObject({ ownerId: run, cwd: e.project.rootPath });
    expect(e.adapters['claude-code'].requests[0]?.prompt).toContain('You are the planner');
  });

  it('a documentation run goes to Ollama without a confirmation, says it cannot read files, and records the route on the run', async () => {
    const e = await env();
    const [run] = e.runOf(e.newTask('Write the readme').id, 'documentation');
    await e.queue.start(run);
    await until(() => e.agents.get(run).state === 'completed');
    expect(e.confirms).toEqual([]);
    expect(e.adapters.ollama.requests[0]).toMatchObject({ model: 'llama3.2:1b', ownerId: run });
    expect(e.adapters.ollama.requests[0]?.cwd).toBeUndefined();
    expect(e.adapters.ollama.requests[0]?.prompt).toContain('You cannot open the project files');
    expect(e.agents.get(run).route?.reasons.join(' ')).toContain('low-risk text work');
  });

  it('Manual routing refuses to guess, and a provider chosen for one run is used as chosen', async () => {
    const e = await env();
    e.routing.profile = 'manual';
    const task = e.tasks.create({ projectId: e.project.id, title: 'Untitled provider', provider: '' });
    const [run] = e.runOf(task.id);
    expect(await failure(e.queue.start(run))).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Manual routing chooses nothing') as unknown });
    expect(e.agents.get(run).requestedAt).toBeNull();
    expect(await e.queue.route(run, { provider: 'codex', model: '' })).toMatchObject({ provider: 'codex', billing: 'unknown' });
    await e.queue.start(run, { provider: 'codex', model: '' });
    await until(() => e.agents.get(run).state === 'completed');
    expect(e.adapters.codex.requests).toHaveLength(1);
  });

  it('Local First falls back to the cloud only with a confirmation that says it costs more than the profile wanted', async () => {
    const e = await env();
    e.routing.profile = 'local-first';
    e.adapters.ollama.status = { ...e.adapters.ollama.status, status: 'installed', message: 'Ollama is installed but not running.' };
    const [run] = e.runOf(e.newTask('Plan it').id);
    e.answers.confirm = false;
    const held = await e.queue.start(run);
    expect(held.route).toMatchObject({ provider: 'claude-code', fallback: true });
    await until(() => e.agents.get(run).note.startsWith('Not sent'));
    expect(e.confirms[0]).toContain('costs more than the routing profile wanted');
    expect(e.adapters['claude-code'].requests).toEqual([]); // declined: nothing was sent
    expect(e.agents.get(run)).toMatchObject({ state: 'queued', requestedAt: null });
  });
});

describe('the queue', () => {
  it('refuses a duplicate launch of the same run, and of the same role for the same task', async () => {
    const e = await env();
    const task = e.newTask('Add jumping');
    const [run] = e.runOf(task.id);
    e.adapters['claude-code'].hold = true;
    await e.queue.start(run);
    await until(() => e.agents.get(run).state === 'planning');
    expect(await failure(e.queue.start(run))).toMatchObject({ code: 'CONFLICT' });
    expect(() => e.runOf(task.id)).toThrow(/already an unfinished/);
    expect(e.adapters['claude-code'].requests).toHaveLength(1);
    expect(await failure(Promise.resolve().then(() => e.queue.record(run, 'completed', 'by hand')))).toMatchObject({ code: 'CONFLICT' });
  });

  it('starts waiting runs by priority, one per provider, while a run of another provider goes alongside', async () => {
    const e = await env();
    e.adapters['claude-code'].hold = true;
    const [first] = e.runOf(e.newTask('First', { priority: 'low' }).id);
    const [normal] = e.runOf(e.newTask('Normal').id);
    const [urgent] = e.runOf(e.newTask('Urgent', { priority: 'critical' }).id);
    const [docs] = e.runOf(e.newTask('Docs').id, 'documentation');
    await e.queue.start(first);
    await until(() => e.agents.get(first).state === 'planning');
    expect((await e.queue.start(normal)).hold).toBe('Waiting for Claude Code: another run is using it.');
    expect((await e.queue.start(urgent)).hold).toContain('Waiting for Claude Code');
    await e.queue.start(docs);
    await until(() => e.agents.get(docs).state === 'completed'); // Ollama ran while Claude Code was busy
    const view = e.queue.view(e.project.id);
    expect(view.runs.slice(0, 3).map((r) => r.taskTitle)).toEqual(['First', 'Urgent', 'Normal']);
    await e.queue.cancel(first);
    expect(e.agents.get(first).state).toBe('cancelled');
    await until(() => e.agents.get(urgent).state === 'planning'); // the critical run went before the earlier normal one
    expect(e.agents.get(normal)).toMatchObject({ state: 'queued', hold: '' });
    expect(e.queue.view(e.project.id).runs.find((r) => r.id === normal)?.hold).toContain('Waiting for Claude Code');
    e.queue.setPriority(normal, 'critical');
    expect(e.agents.get(normal).priority).toBe('critical');
  });

  it('a later workflow step waits for the earlier ones, and a cancelled waiting run never starts', async () => {
    const e = await env({ writesEnabled: true });
    const task = e.newTask('Add jumping');
    const [planner, , reviewer] = e.runOf(task.id, 'implement', { includeReviewer: true });
    expect((await e.queue.start(reviewer)).hold).toBe('Waits for the Planner / architect run of this workflow to finish first.');
    await e.queue.cancel(reviewer);
    await e.queue.start(planner);
    await until(() => e.agents.get(planner).state === 'completed');
    expect(e.adapters['claude-code'].requests).toHaveLength(1);
  });

  it('cancelling a waiting run cancels it; cancelling a finished one is refused', async () => {
    const e = await env();
    e.policy.verdict = { allowed: false, blocks: ['Only 2.0 GB of VRAM is free.'], warnings: [] };
    const [run] = e.runOf(e.newTask('Docs').id, 'documentation');
    await e.queue.start(run);
    expect((await e.queue.cancel(run)).state).toBe('cancelled');
    expect(await failure(e.queue.cancel(run))).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('shutting down stops the running run and records it as cancelled', async () => {
    const e = await env();
    e.adapters['claude-code'].hold = true;
    const [run] = e.runOf(e.newTask('Long plan').id);
    await e.queue.start(run);
    await until(() => e.agents.get(run).state === 'planning');
    await e.queue.shutdown();
    expect(e.agents.get(run).state).toBe('cancelled');
  });
});

describe('the single-writer lock', () => {
  it('refuses write-capable runs until Step 15, without routing or sending anything', async () => {
    const e = await env();
    const task = e.newTask('Add jumping');
    e.tasks.approvePlan(task.id, true);
    const [, implementer] = e.runOf(task.id, 'implement');
    expect(await failure(e.queue.start(implementer))).toMatchObject({ code: 'PERMISSION_REQUIRED', message: expect.stringContaining('Step 15') as unknown });
    expect(e.agents.get(implementer)).toMatchObject({ route: null, requestedAt: null });
    expect(e.queue.view(e.project.id).writesEnabled).toBe(false);
  });

  it('with writes enabled, a running writer blocks a second writer and the reviewer, but not a read-only run', async () => {
    const e = await env({ writesEnabled: true });
    e.adapters['claude-code'].hold = true;
    const [a, b, c, d] = [e.newTask('Writer A'), e.newTask('Writer B'), e.newTask('Review C'), e.newTask('Plan D')];
    for (const t of [a, b, c]) e.tasks.approvePlan(t.id, true);
    const [plannerA, implA] = e.runOf(a.id, 'implement');
    const [plannerB, implB] = e.runOf(b.id, 'implement');
    const [plannerC, implC, reviewerC] = e.runOf(c.id, 'implement', { includeReviewer: true });
    for (const run of [plannerA, plannerB, plannerC, implC]) e.queue.record(run, 'completed', 'done by hand');
    await e.queue.start(implA);
    await until(() => e.agents.get(implA).state === 'running');
    expect(e.queue.view(e.project.id).lock).toMatchObject({ runId: implA, role: 'Implementer', active: true });
    expect((await e.queue.start(implB, { provider: 'codex', model: '' })).hold).toBe('Another run holds the writer lock on this project. Only one writer at a time.');
    expect((await e.queue.start(reviewerC, { provider: 'codex', model: '' })).hold).toBe('Waits until the writer on this project is done, so it looks at a finished change.');
    const [plannerD] = e.runOf(d.id);
    await e.queue.start(plannerD, { provider: 'ollama', model: 'llama3.2:1b' });
    await until(() => e.agents.get(plannerD).state === 'completed'); // read-only runs go alongside the writer
    expect(() => e.queue.acquireWriter(e.project.id, implB, e.project.rootPath)).toThrow(/already writing/);

    await e.queue.cancel(implA); // a writer the app saw end gives the lock back
    await until(() => e.agents.get(implB).state === 'completed');
    await until(() => e.agents.get(reviewerC).state === 'completed');
    expect(e.queue.view(e.project.id).lock).toBeNull();
    const kinds = e.activity.list({ limit: 200 }).map((event) => event.kind);
    expect(kinds.filter((k) => k === 'agent.lock-acquired')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'agent.lock-released')).toHaveLength(2);
  });

  it('a lock left by an interrupted writer survives a restart, blocks the next writer, and is released only by the person', async () => {
    const dir = makeTempDir();
    const before = await env({ dir, writesEnabled: true });
    const first = before.newTask('Writer');
    before.tasks.approvePlan(first.id, true);
    const [, impl] = before.runOf(first.id, 'implement');
    before.queue.acquireWriter(before.project.id, impl, before.project.rootPath);
    before.agents.transition(impl, 'running', 'started'); // the app stops here, mid-run
    before.policy.verdict = { allowed: false, blocks: ['Blender is running.'], warnings: [] };
    const [docs] = before.runOf(before.newTask('Docs').id, 'documentation');
    await before.queue.start(docs);
    await before.queue.shutdown();
    before.db.close();

    const after = await env({ dir, writesEnabled: true });
    after.queue.recover();
    expect(after.agents.get(impl)).toMatchObject({ state: 'failed', note: expect.stringContaining('app closed') as unknown });
    expect(after.agents.get(docs)).toMatchObject({ state: 'queued', requestedAt: null, note: expect.stringContaining('restarted') as unknown });
    expect(after.queue.view(after.project.id).lock).toMatchObject({ runId: impl, active: false });
    expect(after.activity.list({ kinds: ['agent.lock-kept'], limit: 50 })).toHaveLength(1);

    const second = after.newTask('Next writer');
    after.tasks.approvePlan(second.id, true);
    const [planner2, impl2] = after.runOf(second.id, 'implement');
    after.queue.record(planner2, 'completed', 'planned by hand');
    expect((await after.queue.start(impl2)).hold).toContain('writer lock');
    expect(() => after.queue.acquireWriter(after.project.id, impl2, after.project.rootPath)).toThrow(/already writing/);
    after.answers.confirm = false;
    expect(await after.queue.releaseLock(after.project.id)).toEqual({ released: false });
    expect(after.confirms[0]).toContain('Git status');
    after.answers.confirm = true;
    expect(await after.queue.releaseLock(after.project.id)).toEqual({ released: true });
    await until(() => after.agents.get(impl2).state === 'completed');
    expect(after.queue.view(after.project.id).lock).toBeNull();
  });

  it('the lock row itself is kept in the database file across a reopen', async () => {
    const dir = makeTempDir();
    const before = await env({ dir, writesEnabled: true });
    const [, impl] = before.runOf(before.newTask('Writer').id, 'implement');
    before.queue.acquireWriter(before.project.id, impl, before.project.rootPath);
    before.db.close();
    const { db } = await openMigratedDb(dir);
    expect(db.all<{ run_id: string }>('SELECT run_id FROM writer_locks')).toEqual([{ run_id: impl }]);
  });
});

describe('bounded retries and approval', () => {
  it('a failed cloud run is tried again only as a new attempt, each confirmed as a repeat, up to the limit', async () => {
    const e = await env();
    e.adapters['claude-code'].failWith = new AppError('TOOL_FAILED', 'Claude Code stopped with an error.', { retryable: true });
    const [run] = e.runOf(e.newTask('Plan').id);
    await e.queue.start(run);
    await until(() => e.agents.get(run).state === 'failed');
    expect(await failure(e.queue.start(run))).toMatchObject({ code: 'INVALID_INPUT', hint: expect.stringContaining('Try again') as unknown });

    e.answers.confirm = false;
    const second = await e.queue.retry(run);
    expect(second).toMatchObject({ attempt: 2, retryOf: run });
    await until(() => e.agents.get(second.id).note.startsWith('Not sent'));
    expect(e.confirms[1]).toContain('This repeats an earlier Claude Code call that did not finish (attempt 2 of at most 3).');
    expect(e.adapters['claude-code'].requests).toHaveLength(1); // declined: not repeated

    e.answers.confirm = true;
    await e.queue.start(second.id);
    await until(() => e.agents.get(second.id).state === 'failed');
    const third = await e.queue.retry(second.id);
    await until(() => e.agents.get(third.id).state === 'failed');
    expect(e.adapters['claude-code'].requests).toHaveLength(3);
    expect(await failure(e.queue.retry(third.id))).toMatchObject({ code: 'LIMIT_REACHED' });
    expect(await failure(e.queue.retry(run))).toMatchObject({ code: 'INVALID_INPUT', message: 'This attempt was already tried again.' }); // no way around the limit
  });

  it('escalating a failed local run to a cloud agent says so in the confirmation; a local repeat needs none', async () => {
    const e = await env();
    e.adapters.ollama.failWith = new AppError('TOOL_NOT_RUNNING', 'Ollama is not answering.', { retryable: true });
    const [run] = e.runOf(e.newTask('Docs').id, 'documentation');
    await e.queue.start(run);
    await until(() => e.agents.get(run).state === 'failed');
    e.adapters.ollama.failWith = undefined;
    const local = await e.queue.retry(run);
    await until(() => e.agents.get(local.id).state === 'completed');
    expect(e.confirms).toEqual([]);

    e.adapters.ollama.failWith = new AppError('TIMEOUT', 'Ollama did not finish in time.', { retryable: true });
    const [other] = e.runOf(e.newTask('More docs').id, 'documentation');
    await e.queue.start(other);
    await until(() => e.agents.get(other).state === 'failed');
    const cloud = await e.queue.retry(other, { provider: 'claude-code', model: '' });
    await until(() => e.agents.get(cloud.id).state === 'completed');
    expect(e.confirms[0]).toContain('Escalation: the earlier attempt used Ollama (local) on this PC; this attempt goes to Claude Code, which costs more.');
  });

  it('the attempt limit comes from the settings', async () => {
    const e = await env();
    e.routing.maxAttempts = 1;
    e.adapters.ollama.failWith = new AppError('TOOL_FAILED', 'No.');
    const [run] = e.runOf(e.newTask('Docs').id, 'documentation');
    await e.queue.start(run);
    await until(() => e.agents.get(run).state === 'failed');
    expect(await failure(e.queue.retry(run))).toMatchObject({ code: 'LIMIT_REACHED', message: expect.stringContaining('1 time,') as unknown });
  });
});

describe('the local-inference policy', () => {
  it('holds a local start with a visible warning, and starts it once the policy allows; cloud runs are not held', async () => {
    const e = await env();
    e.policy.verdict = { allowed: false, blocks: ['Unreal Editor is running, so local models wait instead of competing for the GPU.'], warnings: [] };
    const [docs] = e.runOf(e.newTask('Docs').id, 'documentation');
    const held = await e.queue.start(docs);
    expect(held).toMatchObject({ state: 'queued', hold: 'Held by the local-inference policy: Unreal Editor is running, so local models wait instead of competing for the GPU.' });
    expect(e.activity.list({ kinds: ['agent.run-held'], limit: 50 })[0]).toMatchObject({ severity: 'warning' });
    const [plan] = e.runOf(e.newTask('Cloud plan').id);
    await e.queue.start(plan);
    await until(() => e.agents.get(plan).state === 'completed');
    expect(e.adapters.ollama.requests).toEqual([]);

    e.policy.verdict = allowed;
    await until(() => e.agents.get(docs).state === 'completed'); // looked at again after the recheck interval
  });
});

describe('cancelling', () => {
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('stops only the program the app started for that run; the app’s other programs and foreign ones keep running', async () => {
    const make = (): ProcessRunner => {
      const r = createProcessRunner({ logger: memoryLogger(), redactor: createRedactor(), graceMs: 100 });
      closeOnCleanup(() => void r.forceKillAll());
      return r;
    };
    const runner = make();
    const foreign = make(); // stands in for a program the app did not start, such as Unreal Editor
    const cwd = makeTempDir();
    const sleeper = (owner: { kind: 'agent-run' | 'git' | 'engine'; id: string }) => ({ executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd, timeoutMs: 60_000, maxOutputBytes: 1024, purpose: 'test', owner });
    const e = await env({
      execute: async (r) => {
        r.onApproved();
        const handle = runner.start(sleeper({ kind: 'agent-run', id: r.runId }));
        r.signal.addEventListener('abort', () => void handle.cancel('stopped by the user'), { once: true });
        const result = await handle.result;
        if (result.status === 'cancelled') throw new AppError('CANCELLED', 'Stopped.');
        return { sent: true, text: 'done', truncated: false };
      },
    });
    const git = runner.start(sleeper({ kind: 'git', id: 'status' }));
    const editor = foreign.start(sleeper({ kind: 'engine', id: 'unreal' }));
    const [run] = e.runOf(e.newTask('Docs').id, 'documentation');
    await e.queue.start(run);
    await until(() => runner.active().some((p) => p.owner.kind === 'agent-run'));
    const agentPid = runner.active().find((p) => p.owner.id === run)?.pid as number;
    expect(() => runner.start(sleeper({ kind: 'agent-run', id: run }))).toThrow(/already has a program running/);

    expect((await e.queue.cancel(run)).state).toBe('cancelled');
    await until(() => !isAlive(agentPid));
    expect(isAlive(git.pid as number)).toBe(true);
    expect(isAlive(editor.pid as number)).toBe(true);
    expect(runner.active().map((p) => p.owner.kind)).toEqual(['git']);
    await Promise.all([runner.forceKillAll(), foreign.forceKillAll()]);
    await Promise.all([git.result, editor.result]); // Windows keeps a folder that a running program uses
  });
});

describe('the queue starts nothing on its own', () => {
  it('imports no process or provider code; it only calls the function it is given', () => {
    expect(readFileSync(join(__dirname, 'queue.ts'), 'utf8')).not.toMatch(/child_process|from '\.\.\/process'|from '\.\.\/providers'/);
  });

  it('a run starts only when a person asks for it; recovering after a restart sends nothing', async () => {
    const e = await env();
    e.runOf(e.newTask('Plan').id);
    e.queue.recover();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(e.adapters['claude-code'].requests).toEqual([]);
    expect(e.db.get<{ n: number }>('SELECT count(*) AS n FROM process_runs')?.n).toBe(0);
  });
});

