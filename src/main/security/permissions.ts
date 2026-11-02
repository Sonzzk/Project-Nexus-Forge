import { randomUUID } from 'node:crypto';
import { AppError } from '@shared/errors';
import { SCOPE_ABOUT, SCOPE_LABELS, type Approval, type ApprovalScope, type Permission, type PermissionScope } from '@shared/permissions';
import type { ActivityLog } from '../logging';
import type { ProjectRegistry } from '../projects';
import type { Db } from '../storage';

// Scoped permissions (spec §14, ARCHITECTURE.md section 28). The only way to obtain a grant is `request`, which shows a native
// window in the main process and records the answer. Nothing else in the app inserts into `permissions`: not the page, not an
// agent, not an import file. `has` is the only thing the rest of the app asks.

export type Confirm = (options: { title: string; message: string; detail?: string; confirmLabel: string }) => Promise<boolean>;

export interface PermissionServiceOptions {
  db: Db;
  projects: ProjectRegistry;
  activity: ActivityLog;
  confirm: Confirm;
  now?: () => Date;
  newId?: () => string;
}

export interface PermissionService {
  grants(projectId: string): Permission[];
  approvals(projectId: string, limit?: number): Approval[];
  /** Asks the person in a native window. Returns the grant, or null if they declined. A repeat of an active grant asks nothing. */
  request(input: { projectId: string; taskId?: string | undefined; scope: PermissionScope }): Promise<Permission | null>;
  /** Ends a grant. Needs no confirmation: it only removes access. */
  revoke(id: string): Permission;
  /** True if an active grant covers this project (or this task) for the scope. */
  has(projectId: string, taskId: string | null, scope: PermissionScope): boolean;
  /** Writes to the approvals log what a person just approved in a native window. */
  record(input: { projectId: string; taskId?: string | null; runId?: string | null; scope: ApprovalScope; what: string; where: string; detail?: string }): Approval;
}

interface GrantRow {
  id: string;
  project_id: string;
  task_id: string | null;
  task_title: string | null;
  scope: PermissionScope;
  what: string;
  working_dir: string;
  granted_at: string;
  revoked_at: string | null;
}
interface ApprovalRow {
  id: string;
  project_id: string;
  task_id: string | null;
  run_id: string | null;
  scope: ApprovalScope;
  what: string;
  working_dir: string;
  detail: string;
  at: string;
}

const grantFrom = (r: GrantRow): Permission => ({ id: r.id, projectId: r.project_id, taskId: r.task_id, taskTitle: r.task_title, scope: r.scope, what: r.what, where: r.working_dir, grantedAt: r.granted_at, revokedAt: r.revoked_at });
const approvalFrom = (r: ApprovalRow): Approval => ({ id: r.id, projectId: r.project_id, taskId: r.task_id, runId: r.run_id, scope: r.scope, what: r.what, where: r.working_dir, detail: r.detail, at: r.at });

const GRANT_SELECT = 'SELECT p.id, p.project_id, p.task_id, t.title AS task_title, p.scope, p.what, p.working_dir, p.granted_at, p.revoked_at FROM permissions p LEFT JOIN tasks t ON t.id = p.task_id';

export function createPermissionService(options: PermissionServiceOptions): PermissionService {
  const { db, projects, activity } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;

  const projectOf = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };

  const service: PermissionService = {
    grants: (projectId) => db.all<GrantRow>(`${GRANT_SELECT} WHERE p.project_id = ? ORDER BY p.granted_at DESC, p.id`, projectId).map(grantFrom),

    approvals: (projectId, limit = 30) => db.all<ApprovalRow>('SELECT * FROM approvals WHERE project_id = ? ORDER BY at DESC, id LIMIT ?', projectId, limit).map(approvalFrom),

    has(projectId, taskId, scope) {
      const found = db.get(
        'SELECT 1 AS found FROM permissions WHERE project_id = ? AND scope = ? AND revoked_at IS NULL AND (task_id IS NULL OR task_id = ?) LIMIT 1',
        projectId, scope, taskId ?? '',
      );
      return found !== undefined;
    },

    async request({ projectId, taskId, scope }) {
      const project = projectOf(projectId);
      let taskTitle: string | null = null;
      if (taskId !== undefined) {
        const task = db.get<{ title: string }>('SELECT title FROM tasks WHERE id = ? AND project_id = ?', taskId, projectId);
        if (task === undefined) throw new AppError('NOT_FOUND', 'That task is not in this project.');
        taskTitle = task.title;
      }
      // Already covered (by a project-wide grant, or by this task's own): nothing to ask.
      const covering = db.all<GrantRow>(`${GRANT_SELECT} WHERE p.project_id = ? AND p.scope = ? AND p.revoked_at IS NULL AND (p.task_id IS NULL OR p.task_id = ?) ORDER BY p.task_id IS NULL DESC LIMIT 1`, projectId, scope, taskId ?? '')[0];
      if (covering !== undefined) return grantFrom(covering);

      const target = taskTitle === null ? `all tasks in "${project.name}"` : `the task "${taskTitle}" in "${project.name}"`;
      const ok = await options.confirm({
        title: `${SCOPE_LABELS[scope]}?`,
        message: `Allow ${SCOPE_LABELS[scope].toLowerCase()} for ${target}?`,
        detail: `${SCOPE_ABOUT[scope]}\n\nFolder: ${project.rootPath}\n\nYou can take this back at any time. Agents and pages cannot grant themselves this permission; only this window can.`,
        confirmLabel: 'Allow',
      });
      if (!ok) return null;

      const id = newId();
      const stamp = now().toISOString();
      const what = `${SCOPE_LABELS[scope]} for ${target}`;
      db.transaction(() => {
        db.run('INSERT INTO permissions (id, project_id, task_id, scope, what, working_dir, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, projectId, taskId ?? null, scope, what, project.rootPath, stamp);
        service.record({ projectId, taskId: taskId ?? null, scope, what: `Granted: ${what}`, where: project.rootPath });
      });
      activity.record({ kind: 'permission.granted', severity: 'info', summary: `You allowed ${SCOPE_LABELS[scope].toLowerCase()} for ${target}.`, projectId, ...(taskId === undefined ? {} : { taskId }), details: { scope, permissionId: id } });
      return db.all<GrantRow>(`${GRANT_SELECT} WHERE p.id = ?`, id).map(grantFrom)[0] ?? null;
    },

    revoke(id) {
      const row = db.get<GrantRow>(`${GRANT_SELECT} WHERE p.id = ?`, id);
      if (row === undefined) throw new AppError('NOT_FOUND', 'That permission does not exist.');
      if (row.revoked_at === null) {
        db.run('UPDATE permissions SET revoked_at = ? WHERE id = ?', now().toISOString(), id);
        activity.record({ kind: 'permission.revoked', severity: 'info', summary: `You took back: ${row.what}.`, projectId: row.project_id, ...(row.task_id === null ? {} : { taskId: row.task_id }), details: { scope: row.scope, permissionId: id } });
      }
      return grantFrom(db.get<GrantRow>(`${GRANT_SELECT} WHERE p.id = ?`, id) as GrantRow);
    },

    record({ projectId, taskId = null, runId = null, scope, what, where, detail = '' }) {
      const id = newId();
      const at = now().toISOString();
      db.run('INSERT INTO approvals (id, project_id, task_id, run_id, scope, what, working_dir, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, projectId, taskId, runId, scope, what.slice(0, 300), where.slice(0, 500), detail.slice(0, 2000), at);
      return { id, projectId, taskId, runId, scope, what: what.slice(0, 300), where: where.slice(0, 500), detail: detail.slice(0, 2000), at };
    },
  };
  return service;
}
