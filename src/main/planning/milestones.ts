import { randomUUID } from 'node:crypto';
import { AppError } from '@shared/errors';
import {
  MilestoneCreateSchema,
  MilestonePatchSchema,
  progressOf,
  RiskCreateSchema,
  RiskPatchSchema,
  type Milestone,
  type PortfolioEntry,
  type Progress,
  type Risk,
  type Snapshot,
  type TaskStatus,
} from '@shared/tasks';
import type { z } from 'zod';
import type { ActivityLog } from '../logging';
import { parseInput } from './parse';
import type { ProjectRegistry } from '../projects';
import type { Db } from '../storage';

// Milestones (the scope tiers of spec §19), their snapshots, the bugs and risks register and the portfolio view across
// projects (spec §20). Progress is only ever computed from stored tasks: done over counted, never an invented percentage.

export interface PlanningService {
  milestones(projectId: string): Milestone[];
  createMilestone(input: z.input<typeof MilestoneCreateSchema>): Milestone;
  updateMilestone(patch: z.input<typeof MilestonePatchSchema>): Milestone;
  removeMilestone(id: string): void;
  /** The milestone the project is working on: the first active one, else the first planned one. */
  currentMilestone(projectId: string): Milestone | null;
  /** Freezes the milestone's progress at this moment, with a label. */
  snapshot(milestoneId: string, label: string): Snapshot;
  snapshots(milestoneId: string): Snapshot[];
  /** Progress of a project's tasks that are not in any milestone, or of all of them. */
  projectProgress(projectId: string): Progress;
  risks(projectId: string): Risk[];
  createRisk(input: z.input<typeof RiskCreateSchema>): Risk;
  updateRisk(patch: z.input<typeof RiskPatchSchema>): Risk;
  removeRisk(id: string): void;
  portfolio(): PortfolioEntry[];
}

export interface PlanningServiceOptions {
  db: Db;
  projects: ProjectRegistry;
  activity: ActivityLog;
  now?: () => Date;
  newId?: () => string;
}

interface MilestoneRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: Milestone['status'];
  scope_tier: Milestone['scopeTier'];
  order_index: number;
  target_date: string | null;
  created_at: string;
}
interface RiskRow {
  id: string;
  project_id: string;
  kind: Risk['kind'];
  title: string;
  description: string;
  severity: Risk['severity'];
  status: Risk['status'];
  task_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Tasks that count towards progress are the ones without subtasks: a parent is just a container for its steps. */
const LEAF_TASKS = 'id NOT IN (SELECT parent_id FROM tasks WHERE parent_id IS NOT NULL)';

export function createPlanningService(options: PlanningServiceOptions): PlanningService {
  const { db, projects, activity } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;

  const project = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };
  const milestoneRow = (id: string): MilestoneRow => {
    const found = db.get<MilestoneRow>('SELECT * FROM milestones WHERE id = ?', id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That milestone does not exist.', { hint: 'It may have been deleted.' });
    return found;
  };
  const statuses = (sql: string, ...params: string[]): TaskStatus[] => db.all<{ status: TaskStatus }>(sql, ...params).map((r) => r.status);
  const milestoneStatuses = (id: string): TaskStatus[] => statuses(`SELECT status FROM tasks WHERE milestone_id = ? AND ${LEAF_TASKS}`, id);
  const toMilestone = (r: MilestoneRow): Milestone => ({
    id: r.id, projectId: r.project_id, title: r.title, description: r.description, status: r.status, scopeTier: r.scope_tier,
    targetDate: r.target_date, order: r.order_index, progress: progressOf(milestoneStatuses(r.id)), createdAt: r.created_at,
  });
  const milestones = (projectId: string): Milestone[] => {
    project(projectId);
    return db.all<MilestoneRow>('SELECT * FROM milestones WHERE project_id = ? ORDER BY order_index, created_at', projectId).map(toMilestone);
  };
  const current = (projectId: string): Milestone | null =>
    milestones(projectId).find((m) => m.status === 'active') ?? milestones(projectId).find((m) => m.status === 'planned') ?? null;
  const toRisk = (r: RiskRow): Risk => ({ id: r.id, projectId: r.project_id, kind: r.kind, title: r.title, description: r.description, severity: r.severity, status: r.status, taskId: r.task_id, createdAt: r.created_at, updatedAt: r.updated_at });
  const riskRow = (id: string): RiskRow => {
    const found = db.get<RiskRow>('SELECT * FROM risks WHERE id = ?', id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That entry does not exist.', { hint: 'It may have been deleted.' });
    return found;
  };
  const checkTask = (projectId: string, taskId: string | null | undefined): void => {
    if (taskId == null) return;
    const t = db.get<{ project_id: string }>('SELECT project_id FROM tasks WHERE id = ?', taskId);
    if (t?.project_id !== projectId) throw new AppError('INVALID_INPUT', 'That task does not belong to this project.', { hint: 'Choose a task of the same project.' });
  };

  return {
    milestones,
    currentMilestone: current,

    createMilestone(raw) {
      const input = parseInput(MilestoneCreateSchema, raw);
      const p = project(input.projectId);
      const id = newId();
      const stamp = now().toISOString();
      const order = (db.get<{ n: number | null }>('SELECT max(order_index) AS n FROM milestones WHERE project_id = ?', input.projectId)?.n ?? 0) + 1;
      db.run(
        'INSERT INTO milestones (id, project_id, title, description, status, scope_tier, order_index, target_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, input.projectId, input.title, input.description ?? '', input.status ?? 'planned', input.scopeTier, order, input.targetDate ?? null, stamp, stamp,
      );
      activity.record({ kind: 'milestone.created', severity: 'info', summary: `Added milestone "${input.title}" to "${p.name}".`, projectId: input.projectId });
      return toMilestone(milestoneRow(id));
    },

    updateMilestone(raw) {
      const patch = parseInput(MilestonePatchSchema, raw);
      const before = milestoneRow(patch.id);
      const columns: Record<string, string | null> = {};
      if (patch.title !== undefined) columns['title'] = patch.title;
      if (patch.description !== undefined) columns['description'] = patch.description;
      if (patch.status !== undefined) columns['status'] = patch.status;
      if (patch.scopeTier !== undefined) columns['scope_tier'] = patch.scopeTier;
      if (patch.targetDate !== undefined) columns['target_date'] = patch.targetDate;
      const names = Object.keys(columns);
      if (names.length > 0) {
        db.run(`UPDATE milestones SET ${names.map((n) => `${n} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...names.map((n) => columns[n] as string | null), now().toISOString(), patch.id);
        activity.record({ kind: 'milestone.updated', severity: 'info', summary: `Updated milestone "${patch.title ?? before.title}"${patch.status === undefined ? '' : ` (${patch.status})`}.`, projectId: before.project_id });
      }
      return toMilestone(milestoneRow(patch.id));
    },

    removeMilestone(id) {
      const before = milestoneRow(id);
      db.run('DELETE FROM milestones WHERE id = ?', id); // its tasks stay, without a milestone
      activity.record({ kind: 'milestone.removed', severity: 'info', summary: `Deleted milestone "${before.title}". Its tasks were kept.`, projectId: before.project_id });
    },

    snapshot(milestoneId, label) {
      const m = milestoneRow(milestoneId);
      const stamp = now().toISOString();
      const all = milestoneStatuses(milestoneId);
      const byStatus: Record<string, number> = {};
      for (const s of all) byStatus[s] = (byStatus[s] ?? 0) + 1;
      const progress = progressOf(all);
      const id = newId();
      const name = label.trim().slice(0, 120) || `Snapshot ${stamp.slice(0, 10)}`;
      db.run('INSERT INTO milestone_snapshots (id, milestone_id, taken_at, label, progress_json, by_status_json) VALUES (?, ?, ?, ?, ?, ?)', id, milestoneId, stamp, name, JSON.stringify(progress), JSON.stringify(byStatus));
      activity.record({ kind: 'milestone.snapshot', severity: 'info', summary: `Took a snapshot of "${m.title}": ${progress.done} of ${progress.total} tasks done.`, projectId: m.project_id });
      return { id, milestoneId, takenAt: stamp, label: name, progress, byStatus };
    },

    snapshots(milestoneId) {
      milestoneRow(milestoneId);
      return db
        .all<{ id: string; milestone_id: string; taken_at: string; label: string; progress_json: string; by_status_json: string }>('SELECT * FROM milestone_snapshots WHERE milestone_id = ? ORDER BY taken_at DESC, id', milestoneId)
        .map((r) => ({ id: r.id, milestoneId: r.milestone_id, takenAt: r.taken_at, label: r.label, progress: JSON.parse(r.progress_json) as Progress, byStatus: JSON.parse(r.by_status_json) as Record<string, number> }));
    },

    projectProgress(projectId) {
      project(projectId);
      return progressOf(statuses(`SELECT status FROM tasks WHERE project_id = ? AND ${LEAF_TASKS}`, projectId));
    },

    risks(projectId) {
      project(projectId);
      return db.all<RiskRow>("SELECT * FROM risks WHERE project_id = ? ORDER BY (status = 'open') DESC, CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC", projectId).map(toRisk);
    },

    createRisk(raw) {
      const input = parseInput(RiskCreateSchema, raw);
      const p = project(input.projectId);
      checkTask(input.projectId, input.taskId);
      const id = newId();
      const stamp = now().toISOString();
      db.run(
        'INSERT INTO risks (id, project_id, kind, title, description, severity, status, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, input.projectId, input.kind, input.title, input.description ?? '', input.severity ?? 'medium', input.status ?? 'open', input.taskId ?? null, stamp, stamp,
      );
      activity.record({ kind: `${input.kind}.created`, severity: input.severity === 'high' ? 'warning' : 'info', summary: `Recorded ${input.kind === 'bug' ? 'a bug' : 'a risk'} in "${p.name}": ${input.title}`, projectId: input.projectId });
      return toRisk(riskRow(id));
    },

    updateRisk(raw) {
      const patch = parseInput(RiskPatchSchema, raw);
      const before = riskRow(patch.id);
      checkTask(before.project_id, patch.taskId);
      const columns: Record<string, string | null> = {};
      if (patch.kind !== undefined) columns['kind'] = patch.kind;
      if (patch.title !== undefined) columns['title'] = patch.title;
      if (patch.description !== undefined) columns['description'] = patch.description;
      if (patch.severity !== undefined) columns['severity'] = patch.severity;
      if (patch.status !== undefined) columns['status'] = patch.status;
      if (patch.taskId !== undefined) columns['task_id'] = patch.taskId;
      const names = Object.keys(columns);
      if (names.length > 0) {
        db.run(`UPDATE risks SET ${names.map((n) => `${n} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...names.map((n) => columns[n] as string | null), now().toISOString(), patch.id);
        if (patch.status !== undefined && patch.status !== before.status)
          activity.record({ kind: `${before.kind}.${patch.status}`, severity: 'info', summary: `${before.kind === 'bug' ? 'Bug' : 'Risk'} "${before.title}" is now ${patch.status}.`, projectId: before.project_id });
      }
      return toRisk(riskRow(patch.id));
    },

    removeRisk(id) {
      riskRow(id);
      db.run('DELETE FROM risks WHERE id = ?', id);
    },

    portfolio() {
      return projects.list().map((p): PortfolioEntry => {
        const open = (kind: string): number => db.get<{ n: number }>("SELECT count(*) AS n FROM risks WHERE project_id = ? AND kind = ? AND status = 'open'", p.id, kind)?.n ?? 0;
        return {
          projectId: p.id,
          name: p.name,
          projectStatus: p.status,
          currentMilestone: current(p.id)?.title ?? null,
          progress: progressOf(statuses(`SELECT status FROM tasks WHERE project_id = ? AND ${LEAF_TASKS}`, p.id)),
          openBugs: open('bug'),
          openRisks: open('risk'),
        };
      });
    },
  };
}
