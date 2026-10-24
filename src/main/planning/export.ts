import { z } from 'zod';
import { AGENT_ROLE_IDS, RUN_STATES } from '@shared/agents';
import { COMPLEXITIES, MILESTONE_STATUSES, PRIORITIES, RISK_KINDS, RISK_STATUSES, ROLES, SCOPE_TIERS, SEVERITIES, TASK_STATUSES, USAGE_CATEGORIES } from '@shared/tasks';
import type { ExportableTable, Row } from '../storage';

// Planning data joins export and import (spec §22, §27.5).

const isoText = z.iso.datetime();
const id = z.string().min(1).max(64);
const safePath = (p: unknown): boolean => typeof p === 'string' && p.length > 0 && p.length <= 400 && !/^([a-zA-Z]:|[\\/])/.test(p) && !p.split(/[\\/]/).includes('..') && !p.includes('\0');

const jsonList = (field: string, each?: (item: unknown) => boolean) => (row: Row): string | undefined => {
  try {
    const value: unknown = JSON.parse(String(row[field]));
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && (each === undefined || each(item)))) return `${field} is not a list of valid text`;
    return undefined;
  } catch {
    return `${field} is not valid JSON`;
  }
};
const jsonObject = (field: string) => (row: Row): string | undefined => {
  try {
    const value: unknown = JSON.parse(String(row[field]));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? undefined : `${field} is not the expected JSON`;
  } catch {
    return `${field} is not valid JSON`;
  }
};

export const planningTables: ExportableTable[] = [
  {
    id: 'milestones',
    label: 'Milestones',
    schema: z.strictObject({
      id,
      project_id: id,
      title: z.string().min(1).max(200),
      description: z.string().max(4000),
      status: z.enum(MILESTONE_STATUSES),
      scope_tier: z.enum(SCOPE_TIERS),
      order_index: z.number().int(),
      target_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
      created_at: isoText,
      updated_at: isoText,
    }),
    key: ['id'],
    parents: [{ column: 'project_id', table: 'projects', parentColumn: 'id' }],
    orderBy: 'order_index, id',
  },
  {
    id: 'tasks',
    label: 'Tasks',
    schema: z.strictObject({
      id,
      project_id: id,
      milestone_id: id.nullable(),
      parent_id: id.nullable(),
      title: z.string().min(1).max(200),
      description: z.string().max(8000),
      subsystem: z.string().max(80),
      priority: z.enum(PRIORITIES),
      complexity: z.enum(COMPLEXITIES),
      category: z.string().max(40),
      status: z.enum(TASK_STATUSES),
      blocked_from: z.enum(TASK_STATUSES).nullable(),
      acceptance_json: z.string().max(60_000),
      files_json: z.string().max(60_000),
      role: z.enum(ROLES),
      provider: z.string().max(80),
      usage: z.enum(USAGE_CATEGORIES),
      test_requirements: z.string().max(4000),
      result_notes: z.string().max(4000),
      plan_approved_at: isoText.nullable(),
      order_index: z.number().int(),
      created_at: isoText,
      updated_at: isoText,
      done_at: isoText.nullable(),
    }),
    key: ['id'],
    parents: [
      { column: 'project_id', table: 'projects', parentColumn: 'id' },
      { column: 'milestone_id', table: 'milestones', parentColumn: 'id' },
      { column: 'parent_id', table: 'tasks', parentColumn: 'id' },
    ],
    // Top-level tasks first, so a subtask's parent is already there when the subtask is read.
    orderBy: '(parent_id IS NOT NULL), order_index, id',
    check: (row) => jsonList('acceptance_json')(row) ?? jsonList('files_json', safePath)(row) ?? (row['parent_id'] === row['id'] ? 'a task cannot be its own parent' : undefined),
  },
  {
    id: 'task_dependencies',
    label: 'Task dependencies',
    schema: z.strictObject({ task_id: id, depends_on_id: id }),
    key: ['task_id', 'depends_on_id'],
    parents: [
      { column: 'task_id', table: 'tasks', parentColumn: 'id' },
      { column: 'depends_on_id', table: 'tasks', parentColumn: 'id' },
    ],
    check: (row) => (row['task_id'] === row['depends_on_id'] ? 'a task cannot depend on itself' : undefined),
    // After the rows are in, the whole graph must still be free of loops; if not, the import is rolled back.
    verify(db) {
      const edges = new Map<string, string[]>();
      const indegree = new Map<string, number>();
      for (const e of db.all<{ task_id: string; depends_on_id: string }>('SELECT task_id, depends_on_id FROM task_dependencies')) {
        edges.set(e.depends_on_id, [...(edges.get(e.depends_on_id) ?? []), e.task_id]);
        indegree.set(e.task_id, (indegree.get(e.task_id) ?? 0) + 1);
        if (!indegree.has(e.depends_on_id)) indegree.set(e.depends_on_id, 0);
      }
      const queue = [...indegree.entries()].filter(([, n]) => n === 0).map(([task]) => task);
      let visited = 0;
      while (queue.length > 0) {
        const task = queue.pop() as string;
        visited++;
        for (const next of edges.get(task) ?? []) {
          const left = (indegree.get(next) ?? 0) - 1;
          indegree.set(next, left);
          if (left === 0) queue.push(next);
        }
      }
      return visited === indegree.size ? undefined : 'the task dependencies in the file would make tasks wait on each other in a loop';
    },
  },
  {
    id: 'task_notes',
    label: 'Task notes',
    schema: z.strictObject({ id, task_id: id, created_at: isoText, text: z.string().max(4000) }),
    key: ['id'],
    parents: [{ column: 'task_id', table: 'tasks', parentColumn: 'id' }],
    orderBy: 'created_at, id',
  },
  {
    id: 'risks',
    label: 'Bugs and risks',
    schema: z.strictObject({
      id,
      project_id: id,
      kind: z.enum(RISK_KINDS),
      title: z.string().min(1).max(200),
      description: z.string().max(4000),
      severity: z.enum(SEVERITIES),
      status: z.enum(RISK_STATUSES),
      task_id: id.nullable(),
      created_at: isoText,
      updated_at: isoText,
    }),
    key: ['id'],
    parents: [
      { column: 'project_id', table: 'projects', parentColumn: 'id' },
      { column: 'task_id', table: 'tasks', parentColumn: 'id' },
    ],
    orderBy: 'created_at, id',
  },
  {
    id: 'milestone_snapshots',
    label: 'Milestone snapshots',
    schema: z.strictObject({ id, milestone_id: id, taken_at: isoText, label: z.string().max(120), progress_json: z.string().max(2000), by_status_json: z.string().max(2000) }),
    key: ['id'],
    parents: [{ column: 'milestone_id', table: 'milestones', parentColumn: 'id' }],
    check: (row) => jsonObject('progress_json')(row) ?? jsonObject('by_status_json')(row),
    orderBy: 'taken_at, id',
  },
];

export const agentTables: ExportableTable[] = [
  {
    id: 'agent_runs',
    label: 'Agent runs',
    schema: z.strictObject({
      id,
      project_id: id,
      task_id: id.nullable(),
      workflow_id: z.string().max(64).nullable(),
      step_index: z.number().int().min(0).max(100),
      role: z.enum(AGENT_ROLE_IDS),
      provider_id: z.string().max(80),
      state: z.enum(RUN_STATES),
      write_capable: z.number().int().min(0).max(1),
      optional: z.number().int().min(0).max(1),
      note: z.string().max(1000),
      created_at: isoText,
      updated_at: isoText,
    }),
    key: ['id'],
    parents: [
      { column: 'project_id', table: 'projects', parentColumn: 'id' },
      { column: 'task_id', table: 'tasks', parentColumn: 'id' },
    ],
    orderBy: 'created_at, step_index, id',
    // Only the implementer writes: a file that says another role can write is not a record this app made.
    check: (row) => (row['write_capable'] === 1 && row['role'] !== 'implementer' ? 'only the implementer role can write' : undefined),
  },
  {
    id: 'agent_run_transitions',
    label: 'Agent run history',
    schema: z.strictObject({ id, run_id: id, from_state: z.string().max(30), to_state: z.enum(RUN_STATES), at: isoText, reason: z.string().max(1000) }),
    key: ['id'],
    parents: [{ column: 'run_id', table: 'agent_runs', parentColumn: 'id' }],
    orderBy: 'at, id',
  },
];
