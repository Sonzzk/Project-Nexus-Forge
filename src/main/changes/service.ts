import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChangeSession, ChangedFile, Review, SessionStatus } from '@shared/changes';
import { AppError } from '@shared/errors';
import type { Checkpoint, GitOps } from '../git';
import type { ActivityLog, Redactor } from '../logging';
import type { ProjectRegistry } from '../projects';
import { isSensitivePath, resolveInside } from '../security';
import type { Confirm, PermissionService } from '../security';
import type { Db } from '../storage';

// Reviewing and undoing what an agent changed (spec §14). Git is the recovery mechanism and nothing here uses reset, clean, a forced
// checkout or a history rewrite. The session's files are what differs from the state saved when the run was approved (so the person's
// own earlier uncommitted work is not the agent's), plus files that are new since then.
// - Approve commits exactly those files (not other staged work) and never a file that could hold secrets.
// - Reject writes back, from the saved state, only those files, after a confirmation that names them; a copy of what is there now is
//   kept first, so rejecting can be undone. Files the agent created are removed only after that copy.
// - Revert makes a new commit that undoes an earlier one (`git revert`); a conflict aborts it and leaves nothing half done.

export interface ChangeServiceOptions {
  db: Db;
  projects: ProjectRegistry;
  git: GitOps;
  permissions: PermissionService;
  activity: ActivityLog;
  redactor: Redactor;
  confirm: Confirm;
  /** Where copies of rejected changes are kept (a folder of the app, not of the project). */
  backupDir: string;
  now?: () => Date;
  newId?: () => string;
}

export interface ChangeService {
  /** Opens a session for a writing run that was just approved. Throws if the state cannot be recorded, so the run does not start. */
  begin(input: { runId: string; projectId: string; taskId: string | null; roleLabel: string; checkpoint: Checkpoint }): Promise<string>;
  sessions(projectId: string): ChangeSession[];
  review(sessionId: string): Promise<Review>;
  approve(sessionId: string): Promise<{ committed: boolean; commit?: string }>;
  reject(sessionId: string): Promise<{ rejected: boolean; savedTo?: string }>;
  /** Reverts a commit in the project's history with a new commit. */
  revert(projectId: string, commit: string): Promise<{ reverted: boolean; commit?: string }>;
}

interface SessionRow {
  id: string;
  project_id: string;
  task_id: string | null;
  task_title: string | null;
  run_id: string;
  role_label: string;
  base_commit: string;
  state_commit: string;
  checkpoint_ref: string;
  untracked_json: string;
  dirty_json: string;
  untracked_truncated: number;
  started_at: string;
  status: SessionStatus;
  commit_hash: string | null;
  finished_at: string | null;
  run_state: string | null;
}

const ACTIVE_RUN = new Set(['planning', 'running', 'awaiting-review', 'testing']);
const MAX_FILES = 300;
const MAX_DIFF_LINES = 4000;
const MAX_TEXT_BYTES = 200_000;
const TOTAL_DIFF_BUDGET = 1_500_000;
const MAX_BACKUP_FILE = 50 * 1024 * 1024;
const MAX_BACKUP_TOTAL = 200 * 1024 * 1024;

const SELECT = `SELECT s.*, t.title AS task_title, r.state AS run_state FROM change_sessions s
  LEFT JOIN tasks t ON t.id = s.task_id LEFT JOIN agent_runs r ON r.id = s.run_id`;

const bytes = (n: number | null): string => (n === null ? 'none' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${n.toLocaleString('en-US')} bytes`);

export function createChangeService(options: ChangeServiceOptions): ChangeService {
  const { db, projects, git, permissions, activity, redactor } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;

  const rowOf = (id: string): SessionRow => {
    const row = db.get<SessionRow>(`${SELECT} WHERE s.id = ?`, id);
    if (row === undefined) throw new AppError('NOT_FOUND', 'That review session does not exist.');
    return row;
  };
  const projectOf = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };
  const sessionOf = (r: SessionRow): ChangeSession => ({
    id: r.id,
    projectId: r.project_id,
    taskId: r.task_id,
    taskTitle: r.task_title,
    runId: r.run_id,
    roleLabel: r.role_label,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    commit: r.commit_hash,
    checkpointRef: r.checkpoint_ref,
    runActive: r.run_state !== null && ACTIVE_RUN.has(r.run_state),
  });

  /** The files that differ from the saved state, without their diffs. */
  async function changedFiles(row: SessionRow, root: string): Promise<{ files: Omit<ChangedFile, 'diff' | 'note'>[]; notes: string[] }> {
    const owner = `changes-${row.id}`;
    const dirty = new Set(JSON.parse(row.dirty_json) as string[]);
    const hadUntracked = new Set(JSON.parse(row.untracked_json) as string[]);
    const notes: string[] = [];
    const tracked = await git.changesSince(root, owner, row.state_commit);
    const status = await git.statusPaths(root, owner);
    if (row.untracked_truncated === 1 || status.truncated) notes.push('The project has a very large number of untracked files, so new files may be missing from this list.');
    const files: Omit<ChangedFile, 'diff' | 'note'>[] = [];
    for (const change of tracked) {
      let after: number | null;
      try {
        after = change.status === 'deleted' ? null : statSync(resolveInside(root, change.path)).size;
      } catch {
        after = null;
      }
      files.push({ ...change, sizeBefore: await git.blobSize(root, owner, row.state_commit, change.path), sizeAfter: after, hidden: isSensitivePath(change.path), overlap: dirty.has(change.path) });
    }
    for (const path of status.untracked.filter((p) => !hadUntracked.has(p))) {
      let size: number | null;
      let binary = false;
      try {
        const full = resolveInside(root, path);
        size = statSync(full).size;
        binary = size > 0 && readFileSync(full).subarray(0, 8000).includes(0);
      } catch {
        size = null;
      }
      files.push({ path, status: 'added', binary, sizeBefore: null, sizeAfter: size, additions: 0, deletions: 0, hidden: isSensitivePath(path), overlap: false });
    }
    if (files.length > MAX_FILES) notes.push(`Only the first ${MAX_FILES} of ${files.length} changed files are listed.`);
    return { files: files.slice(0, MAX_FILES).sort((a, b) => a.path.localeCompare(b.path)), notes };
  }

  /** The diff text of one file, or why there is none. Secrets are removed from what is shown. */
  async function diffOf(row: SessionRow, root: string, file: Omit<ChangedFile, 'diff' | 'note'>): Promise<{ diff: string; note: string; additions: number }> {
    if (file.hidden) return { diff: '', note: 'Not shown: this file can hold secrets. It is never committed from here.', additions: file.additions };
    if (file.binary) return { diff: '', note: `Binary file: ${bytes(file.sizeBefore)} before, ${bytes(file.sizeAfter)} now. Git shows no line changes for it.`, additions: 0 };
    if (file.status === 'added' && file.sizeBefore === null && file.additions === 0) {
      // a new untracked file: show it as an addition
      if ((file.sizeAfter ?? 0) > MAX_TEXT_BYTES) return { diff: '', note: `New file of ${bytes(file.sizeAfter)}: too large to show here.`, additions: 0 };
      try {
        const text = readFileSync(resolveInside(root, file.path), 'utf8');
        const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
        if (text === '') return { diff: '', note: 'New empty file.', additions: 0 };
        if (lines.length > MAX_DIFF_LINES) return { diff: '', note: `New file of ${lines.length.toLocaleString('en-US')} lines: too large to show here.`, additions: lines.length };
        const diff = `--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
        return { diff: redactor.redact(diff), note: '', additions: lines.length };
      } catch {
        return { diff: '', note: 'This file could not be read.', additions: 0 };
      }
    }
    if (file.additions + file.deletions > MAX_DIFF_LINES) return { diff: '', note: `${(file.additions + file.deletions).toLocaleString('en-US')} lines changed: too large to show here.`, additions: file.additions };
    const text = redactor.redact(await git.diffFile(root, `changes-${row.id}`, row.state_commit, file.path));
    return { diff: text.length > MAX_TEXT_BYTES ? `${text.slice(0, MAX_TEXT_BYTES)}\n… cut here …` : text, note: text === '' ? 'No line changes (the file mode or line endings may have changed).' : '', additions: file.additions };
  }

  const ensureReviewable = (row: SessionRow): void => {
    if (row.status !== 'open') throw new AppError('CONFLICT', `These changes were already ${row.status === 'approved' ? 'committed' : 'rejected'}.`);
    if (row.run_state !== null && ACTIVE_RUN.has(row.run_state)) throw new AppError('CONFLICT', 'The run is still working, so its list of changes is not final.', { hint: 'Wait for it to finish, or cancel it first.' });
  };

  return {
    async begin({ runId, projectId, taskId, roleLabel, checkpoint }) {
      const project = projectOf(projectId);
      const status = await git.statusPaths(project.rootPath, `changes-begin-${runId}`);
      const id = newId();
      db.run(
        `INSERT INTO change_sessions (id, project_id, task_id, run_id, role_label, base_commit, state_commit, checkpoint_ref, untracked_json, dirty_json, untracked_truncated, started_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
        id, projectId, taskId, runId, roleLabel, checkpoint.head, checkpoint.commit, checkpoint.ref, JSON.stringify(status.untracked), JSON.stringify(status.tracked.map((t) => t.path)), status.truncated ? 1 : 0, now().toISOString(),
      );
      return id;
    },

    sessions(projectId) {
      projectOf(projectId);
      return db.all<SessionRow>(`${SELECT} WHERE s.project_id = ? ORDER BY s.started_at DESC, s.id LIMIT 50`, projectId).map(sessionOf);
    },

    async review(sessionId) {
      const row = rowOf(sessionId);
      const project = projectOf(row.project_id);
      const { files, notes } = await changedFiles(row, project.rootPath);
      let budget = TOTAL_DIFF_BUDGET;
      const shown: ChangedFile[] = [];
      for (const file of files) {
        if (budget <= 0) {
          shown.push({ ...file, diff: '', note: 'Not shown: the review has reached its size limit.' });
          continue;
        }
        const { diff, note, additions } = await diffOf(row, project.rootPath, file);
        budget -= diff.length;
        shown.push({ ...file, additions: file.status === 'added' && file.additions === 0 ? additions : file.additions, diff, note });
      }
      if (row.status === 'open' && shown.length === 0) notes.push('Nothing differs from the state before the run.');
      return { session: sessionOf(row), files: shown, notes };
    },

    async approve(sessionId) {
      const row = rowOf(sessionId);
      ensureReviewable(row);
      const project = projectOf(row.project_id);
      const { files } = await changedFiles(row, project.rootPath);
      const commitable = files.filter((f) => !f.hidden);
      const held = files.filter((f) => f.hidden);
      if (commitable.length === 0) throw new AppError('INVALID_INPUT', held.length > 0 ? 'The only changed files could hold secrets, so nothing was committed.' : 'There is nothing to commit.', { hint: held.length > 0 ? 'Review those files in a terminal.' : 'Nothing differs from the state before the run.' });
      const overlap = commitable.filter((f) => f.overlap);
      const list = commitable.slice(0, 25).map((f) => `${f.status === 'added' ? 'new' : f.status} ${f.path}`);
      const ok = await options.confirm({
        title: `Commit these changes to ${project.name}?`,
        message: `Commit ${commitable.length} file${commitable.length === 1 ? '' : 's'} changed by the ${row.role_label}${row.task_title === null ? '' : ` for "${row.task_title}"`}?`,
        detail: [
          list.join('\n') + (commitable.length > 25 ? `\n… and ${commitable.length - 25} more` : ''),
          overlap.length > 0 ? `These files already had uncommitted changes of yours when the run started, so your changes in them are committed too:\n${overlap.map((f) => f.path).join('\n')}` : '',
          held.length > 0 ? `Not committed, because they can hold secrets:\n${held.map((f) => f.path).join('\n')}` : '',
          'Only these files are committed. Other changes you have made, staged or not, stay as they are.',
        ].filter(Boolean).join('\n\n'),
        confirmLabel: 'Commit',
      });
      if (!ok) return { committed: false };
      const message = `Agent changes: ${row.role_label}${row.task_title === null ? '' : ` for "${row.task_title}"`}\n\nMade by a ${row.role_label} run (${row.run_id}) and committed after review.`;
      const commit = await git.commitPaths(project.rootPath, `changes-${row.id}`, commitable.map((f) => f.path), message);
      db.run("UPDATE change_sessions SET status = 'approved', commit_hash = ?, finished_at = ? WHERE id = ?", commit, now().toISOString(), row.id);
      permissions.record({ projectId: row.project_id, taskId: row.task_id, runId: row.run_id, scope: 'project-writes', what: `Committed ${commitable.length} file${commitable.length === 1 ? '' : 's'} changed by the ${row.role_label}`, where: project.rootPath, detail: `commit ${commit}` });
      activity.record({ kind: 'changes.approved', severity: 'info', summary: `You committed ${commitable.length} file${commitable.length === 1 ? '' : 's'} changed by the ${row.role_label} in "${project.name}".`, projectId: row.project_id, ...(row.task_id === null ? {} : { taskId: row.task_id }), details: { sessionId: row.id, commit } });
      return { committed: true, commit };
    },

    async reject(sessionId) {
      const row = rowOf(sessionId);
      ensureReviewable(row);
      const project = projectOf(row.project_id);
      const owner = `changes-${row.id}`;
      const { files } = await changedFiles(row, project.rootPath);
      if (files.length === 0) throw new AppError('INVALID_INPUT', 'There is nothing to reject.', { hint: 'Nothing differs from the state before the run.' });
      const inSaved = await git.existsIn(project.rootPath, owner, row.state_commit, files.map((f) => f.path));
      const restore = files.filter((f) => inSaved.has(f.path));
      const remove = files.filter((f) => !inSaved.has(f.path));
      // a copy of what is there now comes first, so rejecting can itself be undone
      const target = join(options.backupDir, row.id);
      const copies = files.filter((f) => f.status !== 'deleted' && !f.hidden);
      let total = 0;
      for (const f of copies) {
        const size = f.sizeAfter ?? 0;
        total += size;
        if (size > MAX_BACKUP_FILE || total > MAX_BACKUP_TOTAL) throw new AppError('LIMIT_REACHED', `${f.path} is too large to keep a copy of, so nothing was changed.`, { hint: 'Review and restore these files in Git yourself.' });
      }
      const ok = await options.confirm({
        title: `Reject the changes in ${project.name}?`,
        message: `Put ${restore.length} file${restore.length === 1 ? '' : 's'} back as they were before the run${remove.length > 0 ? ` and delete ${remove.length} new file${remove.length === 1 ? '' : 's'}` : ''}?`,
        detail: [
          restore.length > 0 ? `Restored from the saved state (${row.checkpoint_ref}):\n${restore.slice(0, 25).map((f) => f.path).join('\n')}` : '',
          remove.length > 0 ? `Deleted, because the run created them:\n${remove.slice(0, 25).map((f) => f.path).join('\n')}` : '',
          `Any edit you made to these files since the run started is replaced too. A copy of what is there now is kept first in:\n${target}`,
          files.some((f) => f.hidden) ? 'Files that can hold secrets are restored but not copied.' : '',
          'Every other file, and all your other uncommitted work, is left alone.',
        ].filter(Boolean).join('\n\n'),
        confirmLabel: 'Reject and restore',
      });
      if (!ok) return { rejected: false };

      for (const f of copies) {
        const from = resolveInside(project.rootPath, f.path);
        if (!existsSync(from)) continue;
        const to = join(target, ...f.path.split('/'));
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
      await git.restore(project.rootPath, owner, row.state_commit, restore.map((f) => f.path));
      for (const f of remove) rmSync(resolveInside(project.rootPath, f.path), { force: true });
      db.run("UPDATE change_sessions SET status = 'rejected', finished_at = ? WHERE id = ?", now().toISOString(), row.id);
      permissions.record({ projectId: row.project_id, taskId: row.task_id, runId: row.run_id, scope: 'project-writes', what: `Rejected the changes of the ${row.role_label}: ${restore.length} restored, ${remove.length} deleted`, where: project.rootPath, detail: copies.length > 0 ? `copies in ${target}` : '' });
      activity.record({ kind: 'changes.rejected', severity: 'warning', summary: `You rejected the changes of the ${row.role_label} in "${project.name}": ${restore.length} file${restore.length === 1 ? '' : 's'} restored, ${remove.length} deleted.`, projectId: row.project_id, ...(row.task_id === null ? {} : { taskId: row.task_id }), details: { sessionId: row.id } });
      return { rejected: true, ...(copies.length > 0 ? { savedTo: target } : {}) };
    },

    async revert(projectId, commit) {
      const project = projectOf(projectId);
      const owner = `revert-${commit.slice(0, 8)}`;
      if (!(await git.isInHistory(project.rootPath, owner, commit))) throw new AppError('NOT_FOUND', 'That commit is not in the history of the current branch.');
      const subject = await git.subject(project.rootPath, owner, commit);
      const ok = await options.confirm({
        title: `Revert a commit in ${project.name}?`,
        message: `Make a new commit that undoes "${subject}" (${commit.slice(0, 8)})?`,
        detail: 'The original commit stays in the history; nothing is reset or deleted. If it cannot be undone cleanly, Git stops, the attempt is aborted and nothing changes.',
        confirmLabel: 'Revert',
      });
      if (!ok) return { reverted: false };
      const created = await git.revert(project.rootPath, owner, commit);
      permissions.record({ projectId, scope: 'project-writes', what: `Reverted commit ${commit.slice(0, 8)}: ${subject}`, where: project.rootPath, detail: `new commit ${created}` });
      activity.record({ kind: 'changes.reverted', severity: 'info', summary: `You reverted "${subject}" in "${project.name}" with a new commit.`, projectId, details: { commit, revert: created } });
      return { reverted: true, commit: created };
    },
  };
}

