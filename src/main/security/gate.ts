import { AppError } from '@shared/errors';
import type { GitSummary } from '@shared/audit';
import type { ActivityLog } from '../logging';
import type { Checkpoint, GitService } from '../git';
import type { ProjectRegistry } from '../projects';
import type { Confirm, PermissionService } from './permissions';

// The pre-write gate (spec §14): before any run that can change project files, check Git, find uncommitted work, say what could
// be overwritten and what the change is likely to touch, ask, save a checkpoint, and record the approved task and folder.
// The gate never changes, stashes, resets or discards anything of the person's. The only things it can write are a checkpoint
// reference (no file changes) and, when asked on its own, a new empty repository in a folder that has none.

export interface WriteGate {
  /** Throws PERMISSION_REQUIRED unless the person granted approved project writes for this project or task. */
  precheck(input: { projectId: string; taskId: string | null }): void;
  /** The confirmation right before a writing run starts. `approved: false` means the person declined and nothing was changed. */
  authorize(input: { runId: string; projectId: string; taskId: string | null; roleLabel: string }): Promise<{ approved: boolean; checkpoint?: string }>;
  /** Creates a repository after explaining it. For folders that have none. */
  initGit(projectId: string): Promise<{ created: boolean }>;
}

export interface WriteGateOptions {
  git: GitService;
  projects: ProjectRegistry;
  permissions: PermissionService;
  activity: ActivityLog;
  confirm: Confirm;
  /** The task's title and the files it says it will change. */
  task: (taskId: string) => { title: string; files: string[] } | undefined;
  /** Opens a review session for the run from the checkpoint just saved (Step 16). */
  sessions?: { begin(input: { runId: string; projectId: string; taskId: string | null; roleLabel: string; checkpoint: Checkpoint }): Promise<string> };
  now?: () => Date;
}

/** What uncommitted work means for the person, in plain words. Pure so the wording is tested. */
export function describeTree(git: GitSummary): { lines: string[]; warnings: string[] } {
  const lines: string[] = [];
  const warnings: string[] = [];
  if (!git.available) {
    warnings.push('Git is not installed, so there is no way to see or undo what the agent changes. Install Git for Windows first if you want that.');
    return { lines, warnings };
  }
  if (!git.isRepository) {
    warnings.push('This folder is not a Git repository, so nothing it changes can be reverted. Create a repository on the Git and Changes page first if you want a way back.');
    return { lines, warnings };
  }
  lines.push(`Branch: ${git.branch ?? 'unknown'}`);
  const c = git.changes;
  if (c === undefined) {
    warnings.push('Git could not report the status, so uncommitted work could not be checked.');
    return { lines, warnings };
  }
  const dirty = c.staged + c.modified + c.untracked + c.conflicted;
  if (dirty === 0) lines.push('Uncommitted work: none.');
  else {
    const parts = [c.staged > 0 && `${c.staged} staged`, c.modified > 0 && `${c.modified} modified`, c.untracked > 0 && `${c.untracked} untracked`, c.conflicted > 0 && `${c.conflicted} in conflict`].filter(Boolean);
    warnings.push(`There is uncommitted work (${parts.join(', ')}). If the agent changes the same files, your edits could be overwritten. Nothing will be stashed, reset or discarded for you; commit your work first, or rely on the checkpoint, which keeps tracked changes (untracked files are not included).`);
  }
  if (c.conflicted > 0) warnings.push('Some files are in a merge conflict. Resolve it before an agent writes anything.');
  if ((git.recentCommits ?? []).length === 0) warnings.push('This repository has no commits yet, so no checkpoint can be saved.');
  return { lines, warnings };
}

export function createWriteGate(options: WriteGateOptions): WriteGate {
  const { git, projects, permissions, activity } = options;
  const now = options.now ?? (() => new Date());

  const projectOf = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };

  const precheck: WriteGate['precheck'] = ({ projectId, taskId }) => {
    projectOf(projectId);
    if (!permissions.has(projectId, taskId, 'project-writes'))
      throw new AppError('PERMISSION_REQUIRED', 'Agents are not allowed to change files in this project yet.', {
        hint: 'Allow approved project writes for this project or task on the AI Workbench (Permissions), then start the run again.',
      });
  };

  return {
    precheck,

    async authorize({ runId, projectId, taskId, roleLabel }) {
      const project = projectOf(projectId);
      precheck({ projectId, taskId });
      const task = taskId === null ? undefined : options.task(taskId);
      const summary = await git.summary(project.rootPath, `gate-${runId}`);
      const tree = describeTree(summary);
      const canCheckpoint = summary.isRepository && (summary.recentCommits ?? []).length > 0;
      const scope =
        task !== undefined && task.files.length > 0
          ? `The task names these files: ${task.files.slice(0, 12).join(', ')}${task.files.length > 12 ? ` and ${task.files.length - 12} more` : ''}. The agent is not limited to them, so check the changes afterwards.`
          : 'The task does not say which files it will change. The agent may change any file it is allowed to edit in this folder. Files that can hold secrets (.env, keys, tokens) are denied to it.';
      const ok = await options.confirm({
        title: `Let the ${roleLabel} change files in ${project.name}?`,
        message: `${roleLabel}${task === undefined ? '' : ` for "${task.title}"`} is about to run with permission to change files in ${project.rootPath}.`,
        detail: [
          ...tree.lines,
          ...tree.warnings.map((w) => `Warning: ${w}`),
          `Likely change scope: ${scope}`,
          canCheckpoint ? 'A checkpoint of the current state is saved first (a Git reference; no file is touched), so afterwards you can review exactly what the agent changed and approve, reject or revert it.' : 'No checkpoint can be saved, so the changes cannot be reviewed or rejected afterwards.',
          'The agent keeps its own permission rules: it may edit files but not run other commands, and recursive deletes, history rewrites and pushes are denied.',
        ].join('\n\n'),
        confirmLabel: 'Allow this run',
      });
      if (!ok) return { approved: false };

      let checkpoint: string | undefined;
      if (canCheckpoint) {
        const stamp = now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        const saved = await git.checkpoint(project.rootPath, `gate-${runId}`, `before-${runId.slice(0, 8)}-${stamp}`);
        checkpoint = saved.ref;
        // If the review session cannot be opened, the run does not start: an agent must not change files that cannot be reviewed.
        await options.sessions?.begin({ runId, projectId, taskId, roleLabel, checkpoint: saved });
      }
      permissions.record({
        projectId,
        taskId,
        runId,
        scope: 'project-writes',
        what: `${roleLabel} run${task === undefined ? '' : ` for "${task.title}"`} may change files`,
        where: project.rootPath,
        detail: JSON.stringify({ branch: summary.branch ?? null, changes: summary.changes ?? null, checkpoint: checkpoint ?? null, repository: summary.isRepository }),
      });
      activity.record({
        kind: 'permission.write-approved',
        severity: tree.warnings.length > 0 ? 'warning' : 'info',
        summary: `You approved a ${roleLabel.toLowerCase()} run that can change files in "${project.name}"${checkpoint === undefined ? '' : `; checkpoint ${checkpoint}`}.`,
        projectId,
        ...(taskId === null ? {} : { taskId }),
        details: { runId, checkpoint: checkpoint ?? null, warnings: tree.warnings.length },
      });
      return { approved: true, ...(checkpoint === undefined ? {} : { checkpoint }) };
    },

    async initGit(projectId) {
      const project = projectOf(projectId);
      const ok = await options.confirm({
        title: 'Create a Git repository?',
        message: `Run "git init" in ${project.rootPath}?`,
        detail:
          'This creates a hidden .git folder so changes to the project can be seen, saved and undone. It does not add, commit or change any of your files, and it does not touch any Git settings. It is refused if the folder already has a .git entry or sits inside another repository.',
        confirmLabel: 'Create repository',
      });
      if (!ok) return { created: false };
      await git.init(project.rootPath, `init-${projectId}`);
      permissions.record({ projectId, scope: 'project-writes', what: 'Created a Git repository (git init)', where: project.rootPath });
      activity.record({ kind: 'git.initialized', severity: 'info', summary: `Created a Git repository in "${project.name}".`, projectId });
      return { created: true };
    },
  };
}
