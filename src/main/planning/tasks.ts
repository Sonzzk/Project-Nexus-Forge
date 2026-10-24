import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@shared/errors';
import {
  allowedNext,
  BreakdownSchema,
  satisfiesDependency,
  STATUS_LABELS,
  TaskCreateSchema,
  TaskPatchSchema,
  wouldCycle,
  type Breakdown,
  type Note,
  type Priority,
  type Recommendations,
  type Task,
  type TaskCreate,
  type TaskPatch,
  type TaskStatus,
} from '@shared/tasks';
import type { ActivityLog } from '../logging';
import { parseInput } from './parse';
import type { ProjectRegistry } from '../projects';
import type { Db } from '../storage';

// Tasks (spec §10): a real lifecycle with valid moves, dependencies without loops, milestones as parents, notes, a
// plan-approval flag, a manual breakdown of a feature into subtasks, and an explainable recommendation for what to do next.

export interface TaskService {
  list(projectId: string): Task[];
  get(id: string): Task;
  create(input: TaskCreate): Task;
  update(patch: TaskPatch): Task;
  remove(id: string): void;
  setStatus(id: string, status: TaskStatus): Task;
  /** Records (or withdraws) the person's approval of the plan before work starts. */
  approvePlan(id: string, approved: boolean): Task;
  setDependencies(id: string, dependsOn: string[]): Task;
  notes(id: string): Note[];
  addNote(id: string, text: string): Note;
  /** One parent task and one subtask per step, optionally chained with dependencies. */
  breakdown(input: Breakdown): Task[];
  recommend(projectId: string): Recommendations;
}

export interface TaskServiceOptions {
  db: Db;
  projects: ProjectRegistry;
  activity: ActivityLog;
  /** The `tasks.requirePlanApproval` setting. */
  requirePlanApproval: () => boolean;
  now?: () => Date;
  newId?: () => string;
}

interface Row {
  id: string;
  project_id: string;
  milestone_id: string | null;
  parent_id: string | null;
  title: string;
  description: string;
  subsystem: string;
  priority: Task['priority'];
  complexity: Task['complexity'];
  category: string;
  status: TaskStatus;
  blocked_from: TaskStatus | null;
  acceptance_json: string;
  files_json: string;
  role: Task['role'];
  provider: string;
  usage: Task['usage'];
  test_requirements: string;
  result_notes: string;
  plan_approved_at: string | null;
  order_index: number;
  created_at: string;
  updated_at: string;
  done_at: string | null;
}

const strings = z.array(z.string());
const parseStrings = (json: string): string[] => {
  const parsed = strings.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : [];
};

const PRIORITY_WEIGHT: Record<Priority, number> = { low: 10, normal: 20, high: 30, critical: 40 };
const ACTIVE: readonly TaskStatus[] = ['in-progress', 'review', 'testing'];

export function createTaskService(options: TaskServiceOptions): TaskService {
  const { db, projects, activity } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;

  const project = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };
  const row = (id: string): Row => {
    const found = db.get<Row>('SELECT * FROM tasks WHERE id = ?', id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That task does not exist.', { hint: 'It may have been deleted. Reload the task list.' });
    return found;
  };

  /** Dependency edges of a whole project: task -> what it waits for. */
  const edgesOf = (projectId: string): Map<string, string[]> => {
    const edges = new Map<string, string[]>();
    for (const e of db.all<{ task_id: string; depends_on_id: string }>(
      'SELECT d.task_id, d.depends_on_id FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?',
      projectId,
    ))
      edges.set(e.task_id, [...(edges.get(e.task_id) ?? []), e.depends_on_id]);
    return edges;
  };

  /** Turns rows into tasks, knowing the whole project so waiting-on and subtask counts are right. */
  const hydrate = (rows: Row[], projectRows: Row[], edges: Map<string, string[]>): Task[] => {
    const byId = new Map(projectRows.map((r) => [r.id, r]));
    const children = new Map<string, number>();
    for (const r of projectRows) if (r.parent_id !== null) children.set(r.parent_id, (children.get(r.parent_id) ?? 0) + 1);
    return rows.map((r): Task => {
      const dependsOn = edges.get(r.id) ?? [];
      return {
        id: r.id,
        projectId: r.project_id,
        milestoneId: r.milestone_id,
        parentId: r.parent_id,
        title: r.title,
        description: r.description,
        subsystem: r.subsystem,
        priority: r.priority,
        complexity: r.complexity,
        category: r.category as Task['category'],
        status: r.status,
        acceptance: parseStrings(r.acceptance_json),
        files: parseStrings(r.files_json),
        role: r.role,
        provider: r.provider,
        usage: r.usage,
        testRequirements: r.test_requirements,
        resultNotes: r.result_notes,
        planApprovedAt: r.plan_approved_at,
        dependsOn,
        waitingOn: dependsOn.flatMap((d) => {
          const dep = byId.get(d);
          return dep === undefined || satisfiesDependency(dep.status) ? [] : [{ id: dep.id, title: dep.title, status: dep.status }];
        }),
        allowedNext: allowedNext(r.status, r.blocked_from),
        children: children.get(r.id) ?? 0,
        order: r.order_index,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        doneAt: r.done_at,
      };
    });
  };

  const listRows = (projectId: string): Row[] => db.all<Row>('SELECT * FROM tasks WHERE project_id = ? ORDER BY order_index, created_at, id', projectId);
  const list = (projectId: string): Task[] => {
    project(projectId);
    const rows = listRows(projectId);
    return hydrate(rows, rows, edgesOf(projectId));
  };
  const get = (id: string): Task => {
    const r = row(id);
    const rows = listRows(r.project_id);
    return hydrate(rows.filter((x) => x.id === id), rows, edgesOf(r.project_id))[0] as Task;
  };

  /** A milestone or parent given by the person must belong to the same project (and a parent cannot itself be a subtask). */
  const checkLinks = (projectId: string, links: { milestoneId?: string | null | undefined; parentId?: string | null | undefined; selfId?: string }): void => {
    if (links.milestoneId != null) {
      const m = db.get<{ project_id: string }>('SELECT project_id FROM milestones WHERE id = ?', links.milestoneId);
      if (m?.project_id !== projectId) throw new AppError('INVALID_INPUT', 'That milestone does not belong to this project.', { hint: 'Choose a milestone of the same project.' });
    }
    if (links.parentId != null) {
      const p = db.get<{ project_id: string; parent_id: string | null }>('SELECT project_id, parent_id FROM tasks WHERE id = ?', links.parentId);
      if (p?.project_id !== projectId || links.parentId === links.selfId) throw new AppError('INVALID_INPUT', 'That parent task is not valid.', { hint: 'Choose another task of the same project.' });
      if (p.parent_id !== null) throw new AppError('INVALID_INPUT', 'A subtask cannot have subtasks of its own.', { hint: 'Keep the breakdown one level deep.' });
      if (links.selfId !== undefined && db.get('SELECT 1 FROM tasks WHERE parent_id = ?', links.selfId) !== undefined)
        throw new AppError('INVALID_INPUT', 'This task has subtasks, so it cannot become a subtask.', { hint: 'Move its subtasks first.' });
    }
  };

  const nextOrder = (projectId: string): number => (db.get<{ n: number | null }>('SELECT max(order_index) AS n FROM tasks WHERE project_id = ?', projectId)?.n ?? 0) + 1;

  const insert = (input: z.output<typeof TaskCreateSchema>, status: TaskStatus, stamp: string): string => {
    const id = newId();
    db.run(
      `INSERT INTO tasks (id, project_id, milestone_id, parent_id, title, description, subsystem, priority, complexity, category, status, acceptance_json, files_json, role, provider, usage, test_requirements, result_notes, order_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.projectId, input.milestoneId ?? null, input.parentId ?? null, input.title, input.description ?? '', input.subsystem ?? '', input.priority ?? 'normal', input.complexity ?? '', input.category ?? '', status,
      JSON.stringify(input.acceptance ?? []), JSON.stringify(input.files ?? []), input.role ?? '', input.provider ?? '', input.usage ?? '', input.testRequirements ?? '', input.resultNotes ?? '', nextOrder(input.projectId), stamp, stamp,
    );
    return id;
  };

  return {
    list,
    get,

    create(raw) {
      const input = parseInput(TaskCreateSchema, raw);
      const p = project(input.projectId);
      checkLinks(input.projectId, input);
      const id = insert(input, input.status ?? 'inbox', now().toISOString());
      activity.record({ kind: 'task.created', severity: 'info', summary: `Added task "${input.title}" to "${p.name}".`, projectId: input.projectId, taskId: id });
      return get(id);
    },

    update(raw) {
      const patch = parseInput(TaskPatchSchema, raw);
      const current = row(patch.id);
      checkLinks(current.project_id, { milestoneId: patch.milestoneId, parentId: patch.parentId, selfId: current.id });
      const columns: Record<string, string | number | null> = {};
      const set = (column: string, value: string | number | null | undefined): void => {
        if (value !== undefined) columns[column] = value;
      };
      set('title', patch.title); set('description', patch.description); set('milestone_id', patch.milestoneId); set('parent_id', patch.parentId);
      set('subsystem', patch.subsystem); set('priority', patch.priority); set('complexity', patch.complexity); set('category', patch.category);
      set('role', patch.role); set('provider', patch.provider); set('usage', patch.usage); set('test_requirements', patch.testRequirements); set('result_notes', patch.resultNotes);
      if (patch.acceptance !== undefined) columns['acceptance_json'] = JSON.stringify(patch.acceptance);
      if (patch.files !== undefined) columns['files_json'] = JSON.stringify(patch.files);
      const names = Object.keys(columns);
      if (names.length > 0) {
        db.run(`UPDATE tasks SET ${names.map((n) => `${n} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...names.map((n) => columns[n] as string | number | null), now().toISOString(), current.id);
        activity.record({ kind: 'task.updated', severity: 'info', summary: `Updated task "${patch.title ?? current.title}".`, projectId: current.project_id, taskId: current.id, details: { fields: names } });
      }
      return get(current.id);
    },

    remove(id) {
      const current = row(id);
      db.run('DELETE FROM tasks WHERE id = ?', id);
      activity.record({ kind: 'task.removed', severity: 'info', summary: `Deleted task "${current.title}".`, projectId: current.project_id });
    },

    setStatus(id, status) {
      const current = get(id);
      const stored = row(id);
      if (!current.allowedNext.includes(status))
        throw new AppError('INVALID_INPUT', `A task cannot go from ${STATUS_LABELS[current.status]} to ${STATUS_LABELS[status]}.`, {
          hint: `From ${STATUS_LABELS[current.status]} it can go to: ${current.allowedNext.map((s) => STATUS_LABELS[s]).join(', ') || 'nowhere'}.`,
        });
      if (status === 'in-progress' && current.status === 'ready') {
        if (current.waitingOn.length > 0)
          throw new AppError('CONFLICT', `This task is waiting on: ${current.waitingOn.map((w) => `"${w.title}" (${STATUS_LABELS[w.status]})`).join(', ')}.`, { hint: 'Finish those first, or remove the dependency.' });
        if (options.requirePlanApproval() && current.planApprovedAt === null)
          throw new AppError('PERMISSION_REQUIRED', 'This task needs an approved plan before work starts.', { hint: 'Review the plan and use "Approve the plan", or turn the requirement off in settings.' });
      }
      if (status === 'done' && current.status === 'review' && current.testRequirements.trim() !== '')
        throw new AppError('INVALID_INPUT', 'This task has test requirements, so it goes through Testing before Done.', { hint: 'Move it to Testing first.' });
      const stamp = now().toISOString();
      db.run(
        'UPDATE tasks SET status = ?, blocked_from = ?, done_at = ?, updated_at = ? WHERE id = ?',
        status,
        status === 'blocked' ? current.status : null,
        status === 'done' ? stamp : null,
        stamp,
        id,
      );
      activity.record({ kind: 'task.status', severity: status === 'failed' ? 'warning' : 'info', summary: `Task "${stored.title}": ${STATUS_LABELS[current.status]} to ${STATUS_LABELS[status]}.`, projectId: stored.project_id, taskId: id, details: { from: current.status, to: status } });
      return get(id);
    },

    approvePlan(id, approved) {
      const current = row(id);
      if (current.status === 'done' || current.status === 'cancelled') throw new AppError('INVALID_INPUT', 'A finished or cancelled task has no plan to approve.');
      const stamp = now().toISOString();
      db.run('UPDATE tasks SET plan_approved_at = ?, updated_at = ? WHERE id = ?', approved ? stamp : null, stamp, id);
      activity.record({ kind: approved ? 'task.plan-approved' : 'task.plan-withdrawn', severity: 'info', summary: `${approved ? 'Approved' : 'Withdrew approval of'} the plan for "${current.title}".`, projectId: current.project_id, taskId: id });
      return get(id);
    },

    setDependencies(id, dependsOn) {
      const current = row(id);
      const unique = [...new Set(dependsOn)];
      const edges = edgesOf(current.project_id);
      edges.set(id, []);
      for (const dep of unique) {
        const d = db.get<{ project_id: string }>('SELECT project_id FROM tasks WHERE id = ?', dep);
        if (d?.project_id !== current.project_id) throw new AppError('INVALID_INPUT', 'A task can only depend on a task of the same project.', { hint: 'Choose from the list.' });
        if (wouldCycle(edges, id, dep)) throw new AppError('INVALID_INPUT', 'That dependency would make the tasks wait on each other in a loop.', { hint: 'Remove one of the dependencies in the loop.' });
        edges.set(id, [...(edges.get(id) ?? []), dep]);
      }
      db.transaction(() => {
        db.run('DELETE FROM task_dependencies WHERE task_id = ?', id);
        for (const dep of unique) db.run('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)', id, dep);
        db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', now().toISOString(), id);
      });
      return get(id);
    },

    notes(id) {
      row(id);
      return db.all<{ id: string; task_id: string; created_at: string; text: string }>('SELECT * FROM task_notes WHERE task_id = ? ORDER BY created_at, id', id).map((n) => ({ id: n.id, taskId: n.task_id, createdAt: n.created_at, text: n.text }));
    },

    addNote(id, text) {
      row(id);
      const trimmed = text.trim();
      if (trimmed === '' || trimmed.length > 4000) throw new AppError('INVALID_INPUT', 'A note needs some text (at most 4000 characters).');
      const noteId = newId();
      const stamp = now().toISOString();
      db.run('INSERT INTO task_notes (id, task_id, created_at, text) VALUES (?, ?, ?, ?)', noteId, id, stamp, trimmed);
      return { id: noteId, taskId: id, createdAt: stamp, text: trimmed };
    },

    breakdown(raw) {
      const input = parseInput(BreakdownSchema, raw);
      const p = project(input.projectId);
      checkLinks(input.projectId, { milestoneId: input.milestoneId });
      const stamp = now().toISOString();
      const ids = db.transaction(() => {
        const parent = insert({ projectId: input.projectId, title: input.title, description: input.description, milestoneId: input.milestoneId }, 'planned', stamp);
        const children: string[] = [];
        for (const step of input.steps) {
          const child = insert({ projectId: input.projectId, title: step.title, milestoneId: input.milestoneId, parentId: parent, acceptance: step.acceptance }, 'planned', stamp);
          if (input.chain && children.length > 0) db.run('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)', child, children[children.length - 1] as string);
          children.push(child);
        }
        return [parent, ...children];
      });
      activity.record({ kind: 'task.breakdown', severity: 'info', summary: `Broke "${input.title}" into ${input.steps.length} tasks in "${p.name}".`, projectId: input.projectId, taskId: ids[0] });
      const rows = listRows(input.projectId);
      return hydrate(rows.filter((r) => ids.includes(r.id)), rows, edgesOf(input.projectId));
    },

    recommend(projectId) {
      const tasks = list(projectId);
      const leaves = tasks.filter((t) => t.children === 0);
      const byOrder = (a: Task, b: Task): number => a.order - b.order;
      const active = leaves.filter((t) => ACTIVE.includes(t.status));
      if (active.length > 0)
        return {
          items: [...active].sort((a, b) => PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority] || byOrder(a, b)).slice(0, 3).map((task) => ({
            task,
            score: PRIORITY_WEIGHT[task.priority],
            reasons: [`Already ${STATUS_LABELS[task.status].toLowerCase()}: finish it before starting something new`, `${task.priority} priority`],
          })),
          message: '',
        };

      const current = db.get<{ id: string }>(
        "SELECT id FROM milestones WHERE project_id = ? AND status IN ('active', 'planned') ORDER BY (status = 'active') DESC, order_index LIMIT 1",
        projectId,
      );
      const openBugs = new Set(db.all<{ task_id: string }>("SELECT task_id FROM risks WHERE project_id = ? AND kind = 'bug' AND status = 'open' AND severity = 'high' AND task_id IS NOT NULL", projectId).map((r) => r.task_id));
      const unlocks = new Map<string, number>();
      for (const t of tasks) if (t.status !== 'done' && t.status !== 'cancelled') for (const d of t.dependsOn) unlocks.set(d, (unlocks.get(d) ?? 0) + 1);

      const ready = leaves.filter((t) => t.status === 'ready');
      const startable = ready.filter((t) => t.waitingOn.length === 0);
      const items = startable
        .map((task) => {
          const reasons = [`${task.priority} priority`];
          let score = PRIORITY_WEIGHT[task.priority];
          if (current !== undefined && task.milestoneId === current.id) {
            score += 15;
            reasons.push('part of the current milestone');
          }
          if (task.category === 'bug-fixing') {
            score += 10;
            reasons.push('fixes a bug');
          }
          if (openBugs.has(task.id)) {
            score += 10;
            reasons.push('linked to an open high-severity bug');
          }
          const n = unlocks.get(task.id) ?? 0;
          if (n > 0) {
            score += 3 * n;
            reasons.push(`unblocks ${n} other task${n === 1 ? '' : 's'}`);
          }
          if (task.planApprovedAt !== null) reasons.push('plan approved');
          return { task, score, reasons };
        })
        .sort((a, b) => b.score - a.score || byOrder(a.task, b.task))
        .slice(0, 3);
      if (items.length > 0) return { items, message: '' };

      const open = leaves.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
      let message: string;
      if (tasks.length === 0) message = 'There are no tasks yet. Add one, or break a feature down into tasks.';
      else if (open.length === 0) message = 'Every task is done or cancelled.';
      else if (ready.length > 0) message = `The ready tasks are waiting on other tasks (${ready.slice(0, 3).map((t) => `"${t.title}"`).join(', ')}). Finish what they wait for.`;
      else message = 'No task is Ready. Move a planned task to Ready when its plan is clear.';
      return { items: [], message };
    },
  };
}
