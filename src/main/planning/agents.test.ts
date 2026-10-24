import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowRequest } from '@shared/agents';
import { RUN_TRANSITIONS } from '@shared/agents';
import type { AppError } from '@shared/errors';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { removeTempDirs } from '../../../test/helpers/temp';
import { copyFixture } from '../../../test/helpers/tree';
import { createActivityLog, createRedactor } from '../logging';
import { createProjectRegistry, projectTables } from '../projects';
import { createTransfer } from '../storage';
import { loadMigrations } from '../storage/migrations';
import { createAgentService } from './agents';
import { agentTables, planningTables } from './export';
import { createTaskService } from './tasks';

afterEach(removeTempDirs);

async function env() {
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const activity = createActivityLog({ db, redactor: createRedactor(), logger });
  const projects = createProjectRegistry({ db, activity, logger });
  const project = projects.add(copyFixture('audit-godot'));
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 24, 11, 0, tick++));
  const tasks = createTaskService({ db, projects, activity, requirePlanApproval: () => false, now });
  const agents = createAgentService({ db, projects, tasks, activity, now });
  const task = tasks.create({ projectId: project.id, title: 'Add jumping', description: 'The player jumps.', acceptance: ['Jump is tunable'], files: ['scripts/player.gd'], provider: 'Claude Code', usage: 'subscription' });
  const request = (extra: Partial<WorkflowRequest> = {}): WorkflowRequest => ({ taskId: task.id, workflow: 'implement', includeReviewer: false, includeQa: false, ...extra });
  return { db, projects, project, tasks, agents, task, request, activity };
}

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as AppError).code;
  }
};

describe('showing a workflow before anything is created', () => {
  it('lists every step with its action, provider and what blocks it, and says launching is not available yet', async () => {
    const e = await env();
    const plan = e.agents.preview(e.request());
    expect(plan).toMatchObject({ workflow: 'implement', label: 'Plan, approve, implement', writesUnavailable: true });
    expect(plan.steps.map((s) => [s.role ?? s.kind, s.included])).toEqual([['planner', true], ['approval', true], ['implementer', true], ['reviewer', false], ['qa', false]]);
    const planner = plan.steps[0];
    expect(planner).toMatchObject({ provider: 'Claude Code', usage: 'subscription', writeCapable: false, blockedBy: '' });
    expect(plan.steps[2]).toMatchObject({ role: 'implementer', writeCapable: true, blockedBy: 'Needs an approved plan. Approve the plan on the task first.' });
    expect(plan.steps[1]?.provider).toBe(''); // the approval is you, not a provider
  });

  it('switches the optional reviewer and QA steps on only when asked, and the plan blocker clears once the plan is approved', async () => {
    const e = await env();
    e.tasks.approvePlan(e.task.id, true);
    const plan = e.agents.preview(e.request({ includeReviewer: true, includeQa: true }));
    expect(plan.steps.filter((s) => s.included).map((s) => s.role ?? s.kind)).toEqual(['planner', 'approval', 'implementer', 'reviewer', 'qa']);
    expect(plan.steps.find((s) => s.role === 'implementer')?.blockedBy).toBe('');
    expect(e.agents.preview(e.request({ includeReviewer: true })).steps.find((s) => s.role === 'qa')?.included).toBe(false);
  });

  it('a finished task blocks every agent step', async () => {
    const e = await env();
    e.tasks.setStatus(e.task.id, 'cancelled');
    expect(e.agents.preview(e.request()).steps.filter((s) => s.kind === 'agent').every((s) => s.blockedBy === 'The task is cancelled.')).toBe(true);
  });

  it('lists the six roles without their prompt templates', async () => {
    const e = await env();
    const roles = e.agents.roles();
    expect(roles.map((r) => r.id)).toEqual(['planner', 'implementer', 'reviewer', 'qa', 'docs', 'assets']);
    expect(roles.filter((r) => r.writeCapable).map((r) => r.id)).toEqual(['implementer']);
    expect(JSON.stringify(roles)).not.toContain('promptTemplate');
  });
});

describe('queueing a workflow', () => {
  it('creates queued records for the included steps only; reviewer and QA are never added on their own', async () => {
    const e = await env();
    const runs = e.agents.createWorkflow(e.request());
    expect(runs.map((r) => [r.role, r.state, r.writeCapable, r.optional])).toEqual([['planner', 'queued', false, false], ['implementer', 'queued', true, false]]);
    expect(runs.every((r) => r.providerId === 'Claude Code' && r.taskId === e.task.id)).toBe(true);
    for (const workflow of ['plan', 'implement', 'documentation', 'assets'] as const) {
      const fresh = await env();
      const roles = fresh.agents.createWorkflow(fresh.request({ workflow })).map((r) => r.role);
      expect(roles, workflow).not.toContain('reviewer');
      expect(roles, workflow).not.toContain('qa');
    }
  });

  it('adds the reviewer and QA runs when, and only when, they are asked for', async () => {
    const e = await env();
    expect(e.agents.createWorkflow(e.request({ includeReviewer: true, includeQa: true })).map((r) => r.role)).toEqual(['planner', 'implementer', 'reviewer', 'qa']);
  });

  it('only the implementer record can write, whatever the workflow', async () => {
    const e = await env();
    for (const workflow of ['plan', 'documentation', 'assets'] as const) {
      const other = e.tasks.create({ projectId: e.project.id, title: `Other ${workflow}` });
      for (const run of e.agents.createWorkflow({ taskId: other.id, workflow, includeReviewer: false, includeQa: false })) expect(run.writeCapable).toBe(false);
    }
    expect(e.agents.createWorkflow(e.request()).filter((r) => r.writeCapable).map((r) => r.role)).toEqual(['implementer']);
  });

  it('refuses a second unfinished run of the same role for a task, and allows it after the first ended', async () => {
    const e = await env();
    const [planner] = e.agents.createWorkflow(e.request({ workflow: 'plan' }));
    expect(codeOf(() => e.agents.createWorkflow(e.request({ workflow: 'plan' })))).toBe('CONFLICT');
    e.agents.recordOutcome((planner as NonNullable<typeof planner>).id, 'cancelled', '');
    expect(e.agents.createWorkflow(e.request({ workflow: 'plan' }))).toHaveLength(1);
  });

  it('keeps a history of every state a run has been in, and records the queueing in the activity list', async () => {
    const e = await env();
    const [planner] = e.agents.createWorkflow(e.request({ workflow: 'plan' })) as [ReturnType<typeof e.agents.createWorkflow>[number]];
    e.agents.transition(planner.id, 'planning', 'Started');
    const history = e.db.all<{ from_state: string; to_state: string; reason: string }>('SELECT from_state, to_state, reason FROM agent_run_transitions WHERE run_id = ? ORDER BY at, rowid', planner.id);
    expect(history.map((h) => `${h.from_state || '-'}>${h.to_state}`)).toEqual(['->queued', 'queued>planning']);
    expect(e.activity.list({ kinds: ['agent.workflow-queued'], limit: 3 })[0]?.summary).toContain('Nothing was started.');
  });
});

describe('the state machine', () => {
  it('follows the table of valid moves and says where a run can go when a move is refused', async () => {
    const e = await env();
    const [planner] = e.agents.createWorkflow(e.request({ workflow: 'plan' })) as [ReturnType<typeof e.agents.createWorkflow>[number]];
    expect(planner.allowedNext).toEqual([...RUN_TRANSITIONS.queued]);
    let error: AppError | undefined;
    try {
      e.agents.transition(planner.id, 'testing', '');
    } catch (caught) {
      error = caught as AppError;
    }
    expect(error?.code).toBe('INVALID_INPUT');
    expect(error?.message).toBe('A run cannot go from Queued to Testing.');
    expect(error?.hint).toContain('Planning');
    const planning = e.agents.transition(planner.id, 'planning', 'Started');
    expect(planning.state).toBe('planning');
    expect(e.agents.transition(planner.id, 'awaiting-approval', 'Plan written').allowedNext).toEqual([...RUN_TRANSITIONS['awaiting-approval']]);
  });

  it('every state a run can be in can be reached by valid moves, and finished runs never move again', async () => {
    const e = await env();
    const reach = (path: Parameters<typeof e.agents.transition>[1][]): string => {
      const other = e.tasks.create({ projectId: e.project.id, title: `T${Math.random()}` });
      const [run] = e.agents.createWorkflow({ taskId: other.id, workflow: 'plan', includeReviewer: false, includeQa: false }) as [ReturnType<typeof e.agents.createWorkflow>[number]];
      for (const state of path) e.agents.transition(run.id, state, '');
      return run.id;
    };
    const id = reach(['planning', 'awaiting-approval', 'running', 'awaiting-review', 'testing', 'completed']);
    expect(codeOf(() => e.agents.transition(id, 'running', ''))).toBe('INVALID_INPUT');
    expect(codeOf(() => e.agents.recordOutcome(id, 'failed', ''))).toBe('INVALID_INPUT');
    reach(['running', 'failed']);
    reach(['planning', 'cancelled']);
  });

  it('the implementer cannot run without an approved plan; read-only roles do not need one', async () => {
    const e = await env();
    const [planner, implementer] = e.agents.createWorkflow(e.request()) as [ReturnType<typeof e.agents.createWorkflow>[number], ReturnType<typeof e.agents.createWorkflow>[number]];
    expect(implementer.role).toBe('implementer');
    expect(codeOf(() => e.agents.transition(implementer.id, 'running', ''))).toBe('PERMISSION_REQUIRED');
    expect(e.agents.runs(e.task.id).find((r) => r.id === implementer.id)?.state).toBe('queued');
    expect(e.agents.transition(planner.id, 'running', '').state).toBe('running'); // read-only: no approval needed
    e.tasks.approvePlan(e.task.id, true);
    expect(e.agents.transition(implementer.id, 'running', '').state).toBe('running');
  });

  it('recording an outcome by hand is not a launch: it only ends a run, with a note, from any unfinished state', async () => {
    const e = await env();
    const [planner] = e.agents.createWorkflow(e.request({ workflow: 'plan' })) as [ReturnType<typeof e.agents.createWorkflow>[number]];
    const done = e.agents.recordOutcome(planner.id, 'completed', 'Wrote the plan myself');
    expect(done).toMatchObject({ state: 'completed', note: 'Recorded by hand: Wrote the plan myself' });
    expect(e.agents.recordOutcome((e.agents.createWorkflow(e.request({ workflow: 'plan' })) as [typeof done])[0].id, 'failed', '').note).toBe('Recorded by hand');
  });
});

describe('prompt preview', () => {
  it('renders what a provider would receive from the task alone and says nothing is sent', async () => {
    const e = await env();
    const preview = e.agents.prompt(e.task.id, 'implementer');
    expect(preview).toMatchObject({ role: 'implementer', writeCapable: true });
    expect(preview.prompt).toContain('Add jumping');
    expect(preview.prompt).toContain('- Jump is tunable');
    expect(preview.prompt).toContain('- scripts/player.gd'); // the name of the file, never its contents
    expect(preview.note).toContain('Nothing is sent');
    expect(e.agents.prompt(e.task.id, 'reviewer').writeCapable).toBe(false);
  });
});

describe('this step starts nothing', () => {
  it('the planning code imports no process or child-process code, and no provider code', () => {
    const dir = join(__dirname);
    const sources = readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    expect(sources).toContain('agents.ts');
    for (const name of sources) {
      const text = readFileSync(join(dir, name), 'utf8');
      expect(text, name).not.toMatch(/child_process|from '\.\.\/process'|from '\.\.\/providers'|\bspawn\(|\.start\(\{/);
    }
  });

  it('the service is built without any runner, so there is nothing it could launch', async () => {
    const e = await env();
    const keys = Object.keys(e.agents).sort();
    expect(keys).toEqual(['createWorkflow', 'get', 'preview', 'prompt', 'recordOutcome', 'roles', 'runs', 'transition']);
    e.agents.createWorkflow(e.request({ includeReviewer: true, includeQa: true }));
    expect(e.db.get<{ n: number }>('SELECT count(*) AS n FROM process_runs')?.n).toBe(0); // no program was ever started
  });
});

describe('persistence and export', () => {
  it('runs go with the project, and survive export and import with their history', async () => {
    const source = await env();
    source.agents.createWorkflow(source.request({ includeReviewer: true }));
    const transfer = createTransfer({ db: source.db, appVersion: 'test', schemaVersion: () => loadMigrations().length });
    for (const table of [...projectTables, ...planningTables, ...agentTables]) transfer.register(table);
    const text = JSON.stringify(transfer.export().file);

    const target = await env();
    target.projects.remove(target.project.id);
    const importer = createTransfer({ db: target.db, appVersion: 'test', schemaVersion: () => loadMigrations().length });
    for (const table of [...projectTables, ...planningTables, ...agentTables]) importer.register(table);
    importer.apply(importer.parse(text), 'skip');
    for (const table of ['agent_runs', 'agent_run_transitions'])
      expect(target.db.all(`SELECT * FROM ${table} ORDER BY 1`), table).toEqual(source.db.all(`SELECT * FROM ${table} ORDER BY 1`));
    expect(target.db.get<{ n: number }>('SELECT count(*) AS n FROM agent_runs')?.n).toBe(3);

    source.projects.remove(source.project.id);
    expect(source.db.get<{ n: number }>('SELECT count(*) AS n FROM agent_runs')?.n).toBe(0);
  });

  it('an imported file cannot make a reviewer able to write', async () => {
    const source = await env();
    source.agents.createWorkflow(source.request({ includeReviewer: true }));
    const transfer = createTransfer({ db: source.db, appVersion: 'test', schemaVersion: () => loadMigrations().length });
    for (const table of [...projectTables, ...planningTables, ...agentTables]) transfer.register(table);
    const file = JSON.parse(JSON.stringify(transfer.export().file)) as { tables: Record<string, Record<string, unknown>[]> };
    const reviewer = file.tables['agent_runs']?.find((r) => r['role'] === 'reviewer') as Record<string, unknown>;
    reviewer['write_capable'] = 1;
    const target = await env();
    const importer = createTransfer({ db: target.db, appVersion: 'test', schemaVersion: () => loadMigrations().length });
    for (const table of [...projectTables, ...planningTables, ...agentTables]) importer.register(table);
    expect(codeOf(() => importer.parse(JSON.stringify(file)))).toBe('INVALID_INPUT');
  });
});
