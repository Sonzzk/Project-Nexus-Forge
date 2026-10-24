import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import type { TaskStatus } from '@shared/tasks';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { removeTempDirs } from '../../../test/helpers/temp';
import { copyFixture } from '../../../test/helpers/tree';
import { createActivityLog, createRedactor } from '../logging';
import { createProjectRegistry } from '../projects';
import { createTransfer } from '../storage';
import { loadMigrations } from '../storage/migrations';
import { planningTables } from './export';
import { createPlanningService } from './milestones';
import { createTaskService } from './tasks';

afterEach(removeTempDirs);

async function env() {
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const activity = createActivityLog({ db, redactor: createRedactor(), logger });
  const projects = createProjectRegistry({ db, activity, logger });
  const a = projects.add(copyFixture('audit-godot'));
  const b = projects.add(copyFixture('audit-node'));
  const rules = { requirePlanApproval: false };
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 24, 10, 0, tick++));
  const tasks = createTaskService({ db, projects, activity, requirePlanApproval: () => rules.requirePlanApproval, now });
  const planning = createPlanningService({ db, projects, activity, now });
  const add = (title: string, extra: Record<string, unknown> = {}, projectId = a.id) => tasks.create({ projectId, title, ...extra });
  const move = (id: string, ...path: TaskStatus[]): void => {
    for (const status of path) tasks.setStatus(id, status);
  };
  const toReady = (id: string): void => move(id, ...(tasks.get(id).status === 'inbox' ? (['planned', 'ready'] as const) : (['ready'] as const)));
  return { db, projects, activity, a, b, tasks, planning, rules, add, move, toReady, logger };
}

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as AppError).code;
  }
};

describe('creating and editing tasks', () => {
  it('stores every field of spec §10 with sensible defaults, in the Inbox', async () => {
    const e = await env();
    const m = e.planning.createMilestone({ projectId: e.a.id, title: 'Prototype', scopeTier: 'prototype' });
    const task = e.add('Add jumping', {
      description: 'The player jumps.', milestoneId: m.id, subsystem: 'Movement', priority: 'high', complexity: 'm', category: 'gameplay',
      acceptance: ['Jump height is tunable'], files: ['scripts/player.gd'], role: 'implementer', provider: 'Claude Code', usage: 'subscription',
      testRequirements: 'Play the test level', resultNotes: '',
    });
    expect(task).toMatchObject({
      status: 'inbox', title: 'Add jumping', milestoneId: m.id, parentId: null, subsystem: 'Movement', priority: 'high', complexity: 'm', category: 'gameplay',
      acceptance: ['Jump height is tunable'], files: ['scripts/player.gd'], role: 'implementer', provider: 'Claude Code', usage: 'subscription',
      testRequirements: 'Play the test level', planApprovedAt: null, dependsOn: [], waitingOn: [], children: 0, doneAt: null,
    });
    expect(task.allowedNext).toEqual(['planned', 'cancelled']);
    expect(e.add('Bare task')).toMatchObject({ priority: 'normal', complexity: '', role: '', usage: '', description: '' });
  });

  it('refuses a missing title, a milestone of another project, and a parent that is itself a subtask', async () => {
    const e = await env();
    expect(codeOf(() => e.add('   '))).toBeDefined();
    const other = e.planning.createMilestone({ projectId: e.b.id, title: 'Other', scopeTier: 'slice' });
    expect(codeOf(() => e.add('x', { milestoneId: other.id }))).toBe('INVALID_INPUT');
    const parent = e.add('Parent');
    const child = e.add('Child', { parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
    expect(codeOf(() => e.add('Grandchild', { parentId: child.id }))).toBe('INVALID_INPUT');
    expect(codeOf(() => e.tasks.update({ id: parent.id, parentId: child.id }))).toBe('INVALID_INPUT'); // would nest under its own child
    expect(codeOf(() => e.tasks.update({ id: child.id, parentId: child.id }))).toBe('INVALID_INPUT');
    expect(e.tasks.get(parent.id).children).toBe(1);
  });

  it('updates only the fields given and records the change', async () => {
    const e = await env();
    const task = e.add('Old title', { priority: 'low', files: ['a.gd'] });
    const updated = e.tasks.update({ id: task.id, title: 'New title', acceptance: ['One', 'Two'] });
    expect(updated).toMatchObject({ title: 'New title', priority: 'low', files: ['a.gd'], acceptance: ['One', 'Two'] });
    expect(e.activity.list({ kinds: ['task.updated'], limit: 5 })).toHaveLength(1);
    expect(codeOf(() => e.tasks.update({ id: 'nope', title: 'x' }))).toBe('NOT_FOUND');
    expect(codeOf(() => e.tasks.update({ id: task.id, files: ['../outside.txt'] }))).toBeDefined();
  });
});

describe('the lifecycle', () => {
  it('walks Inbox to Done in order and stamps the finish time, and reopening clears it', async () => {
    const e = await env();
    const task = e.add('Walk');
    e.move(task.id, 'planned', 'ready', 'in-progress', 'review', 'testing');
    expect(e.tasks.get(task.id).doneAt).toBeNull();
    const done = e.tasks.setStatus(task.id, 'done');
    expect(done.status).toBe('done');
    expect(done.doneAt).not.toBeNull();
    const reopened = e.tasks.setStatus(task.id, 'in-progress');
    expect(reopened).toMatchObject({ status: 'in-progress', doneAt: null });
  });

  it('refuses moves the lifecycle does not allow, saying where the task can go', async () => {
    const e = await env();
    const task = e.add('Skip');
    let error: AppError | undefined;
    try {
      e.tasks.setStatus(task.id, 'done');
    } catch (caught) {
      error = caught as AppError;
    }
    expect(error?.code).toBe('INVALID_INPUT');
    expect(error?.message).toBe('A task cannot go from Inbox to Done.');
    expect(error?.hint).toContain('Planned');
    expect(codeOf(() => e.tasks.setStatus(task.id, 'in-progress'))).toBe('INVALID_INPUT');
    expect(e.tasks.get(task.id).status).toBe('inbox');
  });

  it('a blocked task remembers where it was; failed tasks can be retried; cancelled ones restored', async () => {
    const e = await env();
    const task = e.add('Stuck');
    e.toReady(task.id);
    e.move(task.id, 'in-progress', 'blocked');
    expect(e.tasks.get(task.id).allowedNext).toEqual(['in-progress', 'planned', 'cancelled']);
    expect(codeOf(() => e.tasks.setStatus(task.id, 'review'))).toBe('INVALID_INPUT');
    e.tasks.setStatus(task.id, 'in-progress');
    e.move(task.id, 'failed');
    expect(e.tasks.get(task.id).allowedNext).toEqual(['ready', 'planned', 'cancelled']);
    e.move(task.id, 'ready', 'planned', 'cancelled');
    expect(e.tasks.setStatus(task.id, 'inbox').status).toBe('inbox');
  });

  it('review goes through Testing when the task has test requirements, and straight to Done when it has none', async () => {
    const e = await env();
    const tested = e.add('Tested', { testRequirements: 'Run the suite' });
    e.toReady(tested.id);
    e.move(tested.id, 'in-progress', 'review');
    expect(codeOf(() => e.tasks.setStatus(tested.id, 'done'))).toBe('INVALID_INPUT');
    e.move(tested.id, 'testing', 'done');
    const plain = e.add('Plain');
    e.toReady(plain.id);
    e.move(plain.id, 'in-progress', 'review', 'done');
    expect(e.tasks.get(plain.id).status).toBe('done');
  });

  it('records each move as an activity event', async () => {
    const e = await env();
    const task = e.add('Logged');
    e.move(task.id, 'planned');
    expect(e.activity.list({ kinds: ['task.status'], limit: 5 })[0]?.summary).toBe('Task "Logged": Inbox to Planned.');
  });
});

describe('dependencies', () => {
  it('holds a task back until what it waits on is done or cancelled, and names what it waits on', async () => {
    const e = await env();
    const first = e.add('First');
    const second = e.add('Second');
    e.tasks.setDependencies(second.id, [first.id]);
    expect(e.tasks.get(second.id)).toMatchObject({ dependsOn: [first.id], waitingOn: [{ id: first.id, title: 'First', status: 'inbox' }] });
    e.toReady(second.id);
    let error: AppError | undefined;
    try {
      e.tasks.setStatus(second.id, 'in-progress');
    } catch (caught) {
      error = caught as AppError;
    }
    expect(error?.code).toBe('CONFLICT');
    expect(error?.message).toContain('"First" (Inbox)');

    e.toReady(first.id);
    e.move(first.id, 'in-progress', 'review', 'done');
    expect(e.tasks.get(second.id).waitingOn).toEqual([]);
    expect(e.tasks.setStatus(second.id, 'in-progress').status).toBe('in-progress');

    const third = e.add('Third');
    const fourth = e.add('Fourth');
    e.tasks.setDependencies(fourth.id, [third.id]);
    e.move(third.id, 'cancelled');
    expect(e.tasks.get(fourth.id).waitingOn).toEqual([]); // a cancelled task will never finish, so it no longer holds anything back
  });

  it('rejects loops, self-dependencies and dependencies on another project, and changes nothing when it does', async () => {
    const e = await env();
    const [x, y, z] = [e.add('X'), e.add('Y'), e.add('Z')] as [ReturnType<typeof e.add>, ReturnType<typeof e.add>, ReturnType<typeof e.add>];
    e.tasks.setDependencies(y.id, [x.id]);
    e.tasks.setDependencies(z.id, [y.id]);
    expect(codeOf(() => e.tasks.setDependencies(x.id, [z.id]))).toBe('INVALID_INPUT');
    expect(codeOf(() => e.tasks.setDependencies(x.id, [x.id]))).toBe('INVALID_INPUT');
    expect(e.tasks.get(x.id).dependsOn).toEqual([]);
    const elsewhere = e.add('Elsewhere', {}, e.b.id);
    expect(codeOf(() => e.tasks.setDependencies(x.id, [elsewhere.id]))).toBe('INVALID_INPUT');
    expect(codeOf(() => e.tasks.setDependencies(x.id, ['no-such-task']))).toBe('INVALID_INPUT');
    expect(e.tasks.setDependencies(z.id, [x.id, y.id]).dependsOn.sort()).toEqual([x.id, y.id].sort());
    expect(e.tasks.setDependencies(z.id, []).dependsOn).toEqual([]);
  });

  it('deleting a task removes it from the tasks that waited on it', async () => {
    const e = await env();
    const a = e.add('A');
    const b = e.add('B');
    e.tasks.setDependencies(b.id, [a.id]);
    e.tasks.remove(a.id);
    expect(e.tasks.get(b.id)).toMatchObject({ dependsOn: [], waitingOn: [] });
  });
});

describe('plan approval', () => {
  it('only matters when the setting asks for it, and can be withdrawn', async () => {
    const e = await env();
    const task = e.add('Needs a plan');
    e.toReady(task.id);
    e.rules.requirePlanApproval = true;
    expect(codeOf(() => e.tasks.setStatus(task.id, 'in-progress'))).toBe('PERMISSION_REQUIRED');
    const approved = e.tasks.approvePlan(task.id, true);
    expect(approved.planApprovedAt).not.toBeNull();
    expect(e.tasks.setStatus(task.id, 'in-progress').status).toBe('in-progress');
    expect(e.tasks.approvePlan(task.id, false).planApprovedAt).toBeNull();
    const free = e.add('Free');
    e.toReady(free.id);
    e.rules.requirePlanApproval = false;
    expect(e.tasks.setStatus(free.id, 'in-progress').status).toBe('in-progress');
  });

  it('a finished task has no plan to approve', async () => {
    const e = await env();
    const task = e.add('Done');
    e.toReady(task.id);
    e.move(task.id, 'in-progress', 'review', 'done');
    expect(codeOf(() => e.tasks.approvePlan(task.id, true))).toBe('INVALID_INPUT');
  });
});

describe('notes and breakdown', () => {
  it('keeps notes in order and refuses an empty one', async () => {
    const e = await env();
    const task = e.add('Noted');
    e.tasks.addNote(task.id, '  first  ');
    e.tasks.addNote(task.id, 'second');
    expect(e.tasks.notes(task.id).map((n) => n.text)).toEqual(['first', 'second']);
    expect(codeOf(() => e.tasks.addNote(task.id, '   '))).toBe('INVALID_INPUT');
  });

  it('breaks a feature into a parent and small subtasks with acceptance criteria, optionally chained', async () => {
    const e = await env();
    const m = e.planning.createMilestone({ projectId: e.a.id, title: 'Prototype', scopeTier: 'prototype' });
    const made = e.tasks.breakdown({
      projectId: e.a.id, title: 'Crouching', description: 'Let the player crouch.', milestoneId: m.id, chain: true,
      steps: [{ title: 'Add input', acceptance: ['C toggles crouch'] }, { title: 'Lower the camera', acceptance: [] }, { title: 'Reduce the hitbox', acceptance: ['Fits under pipes'] }],
    });
    expect(made).toHaveLength(4);
    const [parent, one, two, three] = made as [(typeof made)[number], (typeof made)[number], (typeof made)[number], (typeof made)[number]];
    expect(parent).toMatchObject({ title: 'Crouching', children: 3, status: 'planned', milestoneId: m.id });
    expect([one.parentId, two.parentId, three.parentId]).toEqual([parent.id, parent.id, parent.id]);
    expect(one.acceptance).toEqual(['C toggles crouch']);
    expect(one.dependsOn).toEqual([]);
    expect(two.dependsOn).toEqual([one.id]);
    expect(three.dependsOn).toEqual([two.id]);
    const unchained = e.tasks.breakdown({ projectId: e.a.id, title: 'Other', description: '', milestoneId: null, chain: false, steps: [{ title: 'a', acceptance: [] }, { title: 'b', acceptance: [] }] });
    expect(unchained.slice(1).every((t) => t.dependsOn.length === 0)).toBe(true);
    expect(codeOf(() => e.tasks.breakdown({ projectId: e.a.id, title: 'None', description: '', milestoneId: null, chain: false, steps: [] }))).toBeDefined();
  });
});

describe('what to do next', () => {
  it('says why there is nothing to recommend, in each situation', async () => {
    const e = await env();
    expect(e.tasks.recommend(e.a.id)).toEqual({ items: [], message: 'There are no tasks yet. Add one, or break a feature down into tasks.' });
    const planned = e.add('Planned only');
    e.move(planned.id, 'planned');
    expect(e.tasks.recommend(e.a.id).message).toBe('No task is Ready. Move a planned task to Ready when its plan is clear.');
    const waiting = e.add('Waiting');
    e.toReady(waiting.id);
    e.tasks.setDependencies(waiting.id, [planned.id]);
    expect(e.tasks.recommend(e.a.id).message).toContain('waiting on other tasks ("Waiting")');
    e.tasks.setStatus(waiting.id, 'planned');
    e.tasks.setStatus(waiting.id, 'cancelled');
    e.toReady(planned.id);
    e.move(planned.id, 'in-progress', 'review', 'done');
    expect(e.tasks.recommend(e.a.id).message).toBe('Every task is done or cancelled.');
  });

  it('prefers higher priority, then the current milestone, bug fixes, and tasks that unblock others, and explains each', async () => {
    const e = await env();
    const m = e.planning.createMilestone({ projectId: e.a.id, title: 'Now', scopeTier: 'prototype', status: 'active' });
    const plain = e.add('Plain normal');
    const high = e.add('High priority', { priority: 'high' });
    const inMilestone = e.add('Normal in milestone', { milestoneId: m.id });
    const bug = e.add('Fix the crash', { category: 'bug-fixing' });
    const gate = e.add('Gate');
    const behind = e.add('Behind the gate');
    e.tasks.setDependencies(behind.id, [gate.id]);
    for (const t of [plain, high, inMilestone, bug, gate, behind]) e.toReady(t.id);

    const { items } = e.tasks.recommend(e.a.id);
    // 35 = normal 20 + current milestone 15; then high 30 and the bug fix 20 + 10 = 30 tie, and the older task comes first.
    expect(items.map((i) => i.task.title)).toEqual(['Normal in milestone', 'High priority', 'Fix the crash']);
    expect(items[0]?.reasons).toEqual(['normal priority', 'part of the current milestone']);
    expect(items[1]?.reasons).toEqual(['high priority']);
    expect(items[2]?.reasons).toEqual(['normal priority', 'fixes a bug']);
    // The gate unblocks one task (+3) but is still below a bug fix (+10); the blocked task is never offered.
    expect(e.tasks.recommend(e.a.id).items.some((i) => i.task.title === 'Behind the gate')).toBe(false);
    e.tasks.update({ id: gate.id, priority: 'critical' });
    const top = e.tasks.recommend(e.a.id).items[0];
    expect(top?.task.title).toBe('Gate');
    expect(top?.reasons).toContain('unblocks 1 other task');
  });

  it('links a high-severity open bug to its task, and keeps work that is already in progress first', async () => {
    const e = await env();
    const crash = e.add('Crash on load');
    const other = e.add('Other', { priority: 'high' });
    e.toReady(crash.id);
    e.toReady(other.id);
    e.planning.createRisk({ projectId: e.a.id, kind: 'bug', title: 'Crash', severity: 'high', taskId: crash.id });
    // Normal 20 + linked high-severity bug 10 ties with high priority 30; the older task comes first.
    const first = e.tasks.recommend(e.a.id).items[0];
    expect(first?.task.title).toBe('Crash on load');
    expect(first?.reasons).toContain('linked to an open high-severity bug');
    e.tasks.setStatus(crash.id, 'in-progress');
    const next = e.tasks.recommend(e.a.id);
    expect(next.items.map((i) => i.task.title)).toEqual(['Crash on load']);
    expect(next.items[0]?.reasons[0]).toMatch(/Already in progress/);
  });

  it('never offers a parent container; its subtasks are the work', async () => {
    const e = await env();
    const made = e.tasks.breakdown({ projectId: e.a.id, title: 'Feature', description: '', milestoneId: null, chain: true, steps: [{ title: 'Step 1', acceptance: [] }, { title: 'Step 2', acceptance: [] }] });
    for (const t of made) e.toReady(t.id);
    expect(e.tasks.recommend(e.a.id).items.map((i) => i.task.title)).toEqual(['Step 1']); // Step 2 waits on Step 1, Feature is a container
  });
});

describe('milestones, progress and snapshots', () => {
  it('computes progress only from stored tasks, counts subtasks rather than their parent, and has no percentage without tasks', async () => {
    const e = await env();
    const m = e.planning.createMilestone({ projectId: e.a.id, title: 'M1', scopeTier: 'slice' });
    expect(m.progress).toEqual({ total: 0, done: 0, inProgress: 0, blocked: 0, percent: null });
    const made = e.tasks.breakdown({ projectId: e.a.id, title: 'Feature', description: '', milestoneId: m.id, chain: false, steps: [{ title: 'S1', acceptance: [] }, { title: 'S2', acceptance: [] }] });
    e.add('Lone', { milestoneId: m.id });
    const cancelled = e.add('Dropped', { milestoneId: m.id });
    e.move(cancelled.id, 'cancelled');
    e.toReady((made[1] as (typeof made)[number]).id);
    e.move((made[1] as (typeof made)[number]).id, 'in-progress', 'review', 'done');
    expect(e.planning.milestones(e.a.id)[0]?.progress).toEqual({ total: 3, done: 1, inProgress: 0, blocked: 0, percent: 33 });
  });

  it('keeps milestones in order, picks the current one, and keeps tasks when a milestone is deleted', async () => {
    const e = await env();
    const one = e.planning.createMilestone({ projectId: e.a.id, title: 'One', scopeTier: 'prototype' });
    const two = e.planning.createMilestone({ projectId: e.a.id, title: 'Two', scopeTier: 'slice', status: 'active' });
    expect(e.planning.milestones(e.a.id).map((m) => m.title)).toEqual(['One', 'Two']);
    expect(e.planning.currentMilestone(e.a.id)?.id).toBe(two.id);
    e.planning.updateMilestone({ id: two.id, status: 'done' });
    expect(e.planning.currentMilestone(e.a.id)?.id).toBe(one.id);
    const task = e.add('Kept', { milestoneId: one.id });
    e.planning.removeMilestone(one.id);
    expect(e.tasks.get(task.id).milestoneId).toBeNull();
    expect(e.planning.createMilestone({ projectId: e.a.id, title: 'Three', scopeTier: 'release' }).order).toBe(3);
  });

  it('a snapshot freezes the numbers of the moment', async () => {
    const e = await env();
    const m = e.planning.createMilestone({ projectId: e.a.id, title: 'M', scopeTier: 'prototype' });
    const t1 = e.add('T1', { milestoneId: m.id });
    e.add('T2', { milestoneId: m.id });
    const snap = e.planning.snapshot(m.id, 'Before the playtest');
    expect(snap).toMatchObject({ label: 'Before the playtest', progress: { total: 2, done: 0, percent: 0 }, byStatus: { inbox: 2 } });
    e.toReady(t1.id);
    e.move(t1.id, 'in-progress', 'review', 'done');
    expect(e.planning.snapshots(m.id)[0]?.progress.done).toBe(0);
    expect(e.planning.milestones(e.a.id)[0]?.progress.done).toBe(1);
    expect(e.planning.snapshot(m.id, '').label).toMatch(/^Snapshot 2026-10-24$/);
  });

  it('the portfolio summarises every project from its own tasks', async () => {
    const e = await env();
    e.planning.createMilestone({ projectId: e.a.id, title: 'Alpha', scopeTier: 'prototype', status: 'active' });
    const t = e.add('Done one');
    e.toReady(t.id);
    e.move(t.id, 'in-progress', 'review', 'done');
    e.add('Open one');
    e.planning.createRisk({ projectId: e.a.id, kind: 'bug', title: 'B' });
    e.planning.createRisk({ projectId: e.a.id, kind: 'risk', title: 'R' });
    e.projects.update({ id: e.b.id, status: 'paused' });
    const portfolio = e.planning.portfolio();
    const a = portfolio.find((p) => p.projectId === e.a.id);
    const b = portfolio.find((p) => p.projectId === e.b.id);
    expect(a).toMatchObject({ currentMilestone: 'Alpha', openBugs: 1, openRisks: 1, progress: { total: 2, done: 1, percent: 50 } });
    expect(b).toMatchObject({ projectStatus: 'paused', currentMilestone: null, progress: { total: 0, percent: null } });
  });
});

describe('bugs and risks register', () => {
  it('records bugs and risks, sorts open and severe first, and can be closed', async () => {
    const e = await env();
    const low = e.planning.createRisk({ projectId: e.a.id, kind: 'risk', title: 'Multiplayer scope', severity: 'low' });
    const high = e.planning.createRisk({ projectId: e.a.id, kind: 'bug', title: 'Crash', severity: 'high' });
    const closed = e.planning.createRisk({ projectId: e.a.id, kind: 'bug', title: 'Old', severity: 'high', status: 'closed' });
    expect(e.planning.risks(e.a.id).map((r) => r.title)).toEqual(['Crash', 'Multiplayer scope', 'Old']);
    expect(e.planning.updateRisk({ id: low.id, status: 'mitigated' }).status).toBe('mitigated');
    expect(e.planning.updateRisk({ id: high.id, title: 'Crash on load' }).title).toBe('Crash on load');
    e.planning.removeRisk(closed.id);
    expect(e.planning.risks(e.a.id)).toHaveLength(2);
  });

  it('only links a task of the same project', async () => {
    const e = await env();
    const elsewhere = e.add('Elsewhere', {}, e.b.id);
    expect(codeOf(() => e.planning.createRisk({ projectId: e.a.id, kind: 'bug', title: 'x', taskId: elsewhere.id }))).toBe('INVALID_INPUT');
  });
});

describe('persistence', () => {
  it('removing a project removes its tasks, milestones, notes and register', async () => {
    const e = await env();
    const m = e.planning.createMilestone({ projectId: e.a.id, title: 'M', scopeTier: 'slice' });
    const t = e.add('T', { milestoneId: m.id });
    e.tasks.addNote(t.id, 'note');
    e.planning.createRisk({ projectId: e.a.id, kind: 'risk', title: 'R' });
    e.planning.snapshot(m.id, 's');
    e.projects.remove(e.a.id);
    for (const table of ['tasks', 'milestones', 'task_notes', 'risks', 'milestone_snapshots', 'task_dependencies'])
      expect(e.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n, table).toBe(0);
  });
});

describe('export and import of planning data', () => {
  const setupTransfer = (db: Awaited<ReturnType<typeof env>>['db']) => {
    const transfer = createTransfer({ db, appVersion: 'test', schemaVersion: () => loadMigrations().length });
    // Tables of other modules that planning depends on.
    return transfer;
  };

  it('round-trips milestones, tasks with subtasks and dependencies, notes, the register and snapshots exactly', async () => {
    const { projectTables } = await import('../projects');
    const source = await env();
    const m = source.planning.createMilestone({ projectId: source.a.id, title: 'M', scopeTier: 'prototype', status: 'active' });
    const made = source.tasks.breakdown({ projectId: source.a.id, title: 'Feature', description: 'd', milestoneId: m.id, chain: true, steps: [{ title: 'S1', acceptance: ['a'] }, { title: 'S2', acceptance: [] }] });
    source.tasks.addNote((made[1] as (typeof made)[number]).id, 'remember this');
    source.planning.createRisk({ projectId: source.a.id, kind: 'bug', title: 'B', taskId: (made[1] as (typeof made)[number]).id });
    source.planning.snapshot(m.id, 'snap');
    const exporter = setupTransfer(source.db);
    for (const table of [...projectTables, ...planningTables]) exporter.register(table);
    const text = JSON.stringify(exporter.export().file);

    const target = await env();
    target.projects.remove(target.a.id);
    target.projects.remove(target.b.id);
    const importer = setupTransfer(target.db);
    for (const table of [...projectTables, ...planningTables]) importer.register(table);
    const parsed = importer.parse(text);
    const preview = importer.preview(parsed);
    expect(preview.tables.find((t) => t.id === 'tasks')).toMatchObject({ total: 3, added: 3, blocked: 0 });
    importer.apply(parsed, 'skip');
    const dump = (db: typeof source.db, table: string): unknown[] => db.all(`SELECT * FROM ${table} ORDER BY 1, 2`);
    for (const table of ['milestones', 'tasks', 'task_dependencies', 'task_notes', 'risks', 'milestone_snapshots'])
      expect(dump(target.db, table), table).toEqual(dump(source.db, table));
  });

  it('rejects a file whose dependencies would loop, applies nothing, and refuses unsafe file paths', async () => {
    const { projectTables } = await import('../projects');
    const source = await env();
    const x = source.add('X');
    const y = source.add('Y');
    source.tasks.setDependencies(y.id, [x.id]);
    const exporter = setupTransfer(source.db);
    for (const table of [...projectTables, ...planningTables]) exporter.register(table);
    const file = JSON.parse(JSON.stringify(exporter.export().file)) as { tables: Record<string, Record<string, unknown>[]> };
    file.tables['task_dependencies']?.push({ task_id: x.id, depends_on_id: y.id }); // closes the loop

    const target = await env();
    target.projects.remove(target.a.id);
    target.projects.remove(target.b.id);
    const importer = setupTransfer(target.db);
    for (const table of [...projectTables, ...planningTables]) importer.register(table);
    const parsed = importer.parse(JSON.stringify(file));
    expect(codeOf(() => importer.apply(parsed, 'skip'))).toBe('INVALID_INPUT');
    expect(target.db.get<{ n: number }>('SELECT count(*) AS n FROM tasks')?.n).toBe(0);
    expect(target.db.get<{ n: number }>('SELECT count(*) AS n FROM projects')?.n).toBe(0);

    const unsafe = JSON.parse(JSON.stringify(exporter.export().file)) as { tables: Record<string, Record<string, unknown>[]> };
    (unsafe.tables['tasks']?.[0] as Record<string, unknown>)['files_json'] = JSON.stringify(['..\\..\\Windows\\win.ini']);
    expect(codeOf(() => importer.parse(JSON.stringify(unsafe)))).toBe('INVALID_INPUT');
  });

  it('skips a subtask whose parent is missing instead of failing the import', async () => {
    const { projectTables } = await import('../projects');
    const source = await env();
    const made = source.tasks.breakdown({ projectId: source.a.id, title: 'P', description: '', milestoneId: null, chain: false, steps: [{ title: 'C', acceptance: [] }] });
    const exporter = setupTransfer(source.db);
    for (const table of [...projectTables, ...planningTables]) exporter.register(table);
    const file = JSON.parse(JSON.stringify(exporter.export().file)) as { tables: Record<string, Record<string, unknown>[]> };
    file.tables['tasks'] = file.tables['tasks']?.filter((t) => t['id'] !== (made[0] as (typeof made)[number]).id) ?? [];
    const target = await env();
    target.projects.remove(target.a.id);
    target.projects.remove(target.b.id);
    const importer = setupTransfer(target.db);
    for (const table of [...projectTables, ...planningTables]) importer.register(table);
    const parsed = importer.parse(JSON.stringify(file));
    expect(importer.preview(parsed).tables.find((t) => t.id === 'tasks')).toMatchObject({ total: 1, added: 0, blocked: 1 });
    importer.apply(parsed, 'skip');
    expect(target.db.get<{ n: number }>('SELECT count(*) AS n FROM tasks')?.n).toBe(0);
  });
});
