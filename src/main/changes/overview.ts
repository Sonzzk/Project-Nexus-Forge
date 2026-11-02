import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { GitOverview, Protection, WorktreeItem } from '@shared/changes';
import { AppError } from '@shared/errors';
import type { GitOps, GitService } from '../git';
import { CHECKPOINT_NAME } from '../git/git';
import type { ActivityLog } from '../logging';
import type { ProjectRegistry } from '../projects';
import { resolveInside } from '../security';
import type { Confirm, PermissionService } from '../security';
import type { Db } from '../storage';

// Branches, named checkpoints, the limits of what Git protects, and linked working trees (spec §14, §11).
// - A checkpoint is a Git reference to a commit holding the current tracked state; it changes no file and needs no window.
// - Working trees are created and removed only after a window, only by this app for its own folder, and never while an agent holds
//   the project's writer lock. Git itself refuses to remove one with uncommitted work, and the app never forces it.

export interface OverviewServiceOptions {
  db: Db;
  projects: ProjectRegistry;
  git: GitOps;
  gitService: GitService;
  permissions: PermissionService;
  activity: ActivityLog;
  confirm: Confirm;
  /** The folder linked working trees are created in, inside the app's data folder (never inside a project). */
  worktreeDir: string;
  /** True while a run holds the project's writer lock (Step 13). */
  writerLocked: (projectId: string) => boolean;
  now?: () => Date;
  newId?: () => string;
}

export interface OverviewService {
  overview(projectId: string): Promise<GitOverview>;
  checkpoint(projectId: string, name: string): Promise<{ name: string; ref: string }>;
  addWorktree(projectId: string, name: string): Promise<{ created: boolean }>;
  removeWorktree(id: string): Promise<{ removed: boolean }>;
}

const BINARY_EXTENSIONS = new Set(['.uasset', '.umap', '.blend', '.fbx', '.png', '.jpg', '.jpeg', '.tga', '.psd', '.wav', '.mp3', '.ogg', '.mp4', '.exr', '.hdr', '.dll', '.exe', '.zip', '.7z', '.bank', '.mov', '.tif', '.tiff', '.dds']);
const WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const LARGE_MB = 50;

interface WorktreeRow {
  id: string;
  project_id: string;
  name: string;
  path: string;
  branch: string;
  created_at: string;
  removed_at: string | null;
}

export function createOverviewService(options: OverviewServiceOptions): OverviewService {
  const { db, projects, git, permissions, activity } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;

  const projectOf = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };

  /** What Git cannot be relied on to protect in this project: tracked binary assets without LFS, untracked and ignored files. */
  async function protection(root: string, owner: string): Promise<Protection> {
    let lfs: boolean;
    try {
      lfs = /filter=lfs/.test(readFileSync(resolveInside(root, '.gitattributes'), 'utf8'));
    } catch {
      lfs = false;
    }
    let binaryFiles = 0;
    let largest = 0;
    for (const path of (await git.trackedFiles(root, owner)).slice(0, 20_000)) {
      if (!BINARY_EXTENSIONS.has(extname(path).toLowerCase())) continue;
      binaryFiles++;
      try {
        largest = Math.max(largest, statSync(resolveInside(root, path)).size);
      } catch {
        // a tracked file that is missing from disk does not change the warning
      }
    }
    const largestBinaryMb = Math.round((largest / 1024 / 1024) * 10) / 10;
    const notes = ['A checkpoint or commit holds tracked files only. Untracked and ignored files, such as engine caches and build folders, are not in it.'];
    if (binaryFiles > 0 && !lfs)
      notes.push(`${binaryFiles.toLocaleString('en-US')} tracked binary asset${binaryFiles === 1 ? '' : 's'} (the largest is ${largestBinaryMb} MB) are stored in full in every version without Git LFS. Git can become very slow and large, and a commit is not a real backup of big assets. Consider Git LFS or a separate backup of the content folders.`);
    else if (largestBinaryMb >= LARGE_MB) notes.push(`A tracked binary file is ${largestBinaryMb} MB.`);
    if (lfs) notes.push('Git LFS is set up here. LFS files live outside the repository, so keep that storage backed up as well.');
    return { lfs, binaryFiles, largestBinaryMb, notes };
  }

  const worktreeItems = async (projectId: string, root: string, owner: string): Promise<WorktreeItem[]> => {
    const rows = db.all<WorktreeRow>('SELECT * FROM worktrees WHERE project_id = ? AND removed_at IS NULL ORDER BY created_at', projectId);
    const live = new Set((await git.worktrees(root, owner)).map((w) => w.path.replace(/\\/g, '/').toLowerCase()));
    return rows.map((r) => ({ id: r.id, name: r.name, path: r.path, branch: r.branch, createdAt: r.created_at, present: live.has(r.path.replace(/\\/g, '/').toLowerCase()) }));
  };

  const guard = (projectId: string, what: string): void => {
    if (options.writerLocked(projectId)) throw new AppError('CONFLICT', `An agent run is writing to this project, so ${what} now.`, { hint: 'Wait for the run to finish or cancel it.' });
  };

  return {
    async overview(projectId) {
      const project = projectOf(projectId);
      const owner = `overview-${projectId}`;
      const empty: GitOverview = { branches: [], checkpoints: [], worktrees: [], protection: { lfs: false, binaryFiles: 0, largestBinaryMb: 0, notes: [] }, note: '' };
      try {
        if ((await git.head(project.rootPath, owner)) === undefined) return { ...empty, note: 'This is not a Git repository with commits yet, so there are no branches or checkpoints to show.' };
        const [branches, checkpoints, worktrees, notes] = await Promise.all([git.branches(project.rootPath, owner), git.checkpoints(project.rootPath, owner), worktreeItems(projectId, project.rootPath, owner), protection(project.rootPath, owner)]);
        return { branches, checkpoints, worktrees, protection: notes, note: '' };
      } catch (error) {
        if (error instanceof AppError && (error.code === 'TOOL_NOT_INSTALLED' || error.code === 'TOOL_FAILED')) return { ...empty, note: error.code === 'TOOL_NOT_INSTALLED' ? 'Git is not installed.' : 'This folder is not a Git repository.' };
        throw error;
      }
    },

    async checkpoint(projectId, name) {
      const project = projectOf(projectId);
      if (!CHECKPOINT_NAME.test(name)) throw new AppError('INVALID_INPUT', 'A checkpoint name uses letters, digits, dots, dashes and underscores (up to 80 characters).');
      const saved = await options.gitService.checkpoint(project.rootPath, `checkpoint-${projectId}`, name);
      permissions.record({ projectId, scope: 'project-writes', what: `Saved the checkpoint "${name}"`, where: project.rootPath, detail: saved.ref });
      activity.record({ kind: 'git.checkpoint', severity: 'info', summary: `Saved the checkpoint "${name}" in "${project.name}"${saved.includesUncommitted ? ' (with your uncommitted tracked changes)' : ''}.`, projectId, details: { ref: saved.ref } });
      return { name, ref: saved.ref };
    },

    async addWorktree(projectId, name) {
      const project = projectOf(projectId);
      if (!WORKTREE_NAME.test(name)) throw new AppError('INVALID_INPUT', 'A working tree name uses letters, digits, dots, dashes and underscores (up to 60 characters).');
      guard(projectId, 'a working tree cannot be added');
      if (db.get('SELECT 1 AS found FROM worktrees WHERE project_id = ? AND name = ? AND removed_at IS NULL', projectId, name) !== undefined) throw new AppError('CONFLICT', `A working tree named "${name}" already exists.`);
      const path = join(options.worktreeDir, `${projectId.slice(0, 8)}-${name}`);
      const branch = `gdcc/${name}`;
      const ok = await options.confirm({
        title: 'Add a separate working tree?',
        message: `Create a second working copy of "${project.name}" on a new branch "${branch}"?`,
        detail: `A linked Git working tree is created in:\n${path}\n\nIt is a separate folder with its own files on the new branch, so work on it cannot touch your project folder. Your project folder and its branch are not changed. It can be removed later; Git refuses to remove one that has uncommitted work.`,
        confirmLabel: 'Create working tree',
      });
      if (!ok) return { created: false };
      mkdirSync(options.worktreeDir, { recursive: true });
      await git.addWorktree(project.rootPath, `worktree-${projectId}`, path, branch);
      db.run('INSERT INTO worktrees (id, project_id, name, path, branch, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId(), projectId, name, path, branch, now().toISOString());
      permissions.record({ projectId, scope: 'project-writes', what: `Created the working tree "${name}" on branch ${branch}`, where: path });
      activity.record({ kind: 'git.worktree-added', severity: 'info', summary: `Created the working tree "${name}" for "${project.name}" on branch ${branch}.`, projectId });
      return { created: true };
    },

    async removeWorktree(id) {
      const row = db.get<WorktreeRow>('SELECT * FROM worktrees WHERE id = ? AND removed_at IS NULL', id);
      if (row === undefined) throw new AppError('NOT_FOUND', 'That working tree is not one this app created, or it was already removed.');
      const project = projectOf(row.project_id);
      guard(row.project_id, 'a working tree cannot be removed');
      const ok = await options.confirm({
        title: 'Remove this working tree?',
        message: `Remove the working tree "${row.name}" of "${project.name}"?`,
        detail: `The folder ${row.path} is removed. The branch ${row.branch} and its commits stay in your repository. If the folder has uncommitted work, Git refuses and nothing is removed.`,
        confirmLabel: 'Remove working tree',
      });
      if (!ok) return { removed: false };
      await git.removeWorktree(project.rootPath, `worktree-${row.project_id}`, row.path);
      db.run('UPDATE worktrees SET removed_at = ? WHERE id = ?', now().toISOString(), id);
      permissions.record({ projectId: row.project_id, scope: 'project-writes', what: `Removed the working tree "${row.name}"`, where: row.path });
      activity.record({ kind: 'git.worktree-removed', severity: 'info', summary: `Removed the working tree "${row.name}" of "${project.name}".`, projectId: row.project_id });
      return { removed: true };
    },
  };
}
