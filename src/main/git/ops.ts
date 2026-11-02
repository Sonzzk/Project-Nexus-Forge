import { AppError } from '@shared/errors';
import type { ProcessRunner } from '../process';
import { createGitExec, locateGit } from './git';

// Git operations for reviewing and undoing agent changes (spec §14). Each is a fixed set of arguments through the process runner;
// paths always come after `--` and are taken literally (GIT_LITERAL_PATHSPECS), so a file name can never act as an option or a
// pathspec pattern. Nothing here resets, cleans, force-checks-out or rewrites history. The ones that change files are narrow:
// `restore` writes only the working tree files it is given, from a saved commit; `commitPaths` commits only the paths it is given.

export const COMMIT_ID = /^[0-9a-f]{40}$/;

export interface StatusPaths {
  tracked: { path: string; index: string; worktree: string }[];
  untracked: string[];
  /** More paths than the cap: the lists are incomplete. */
  truncated: boolean;
}
export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'other';
  binary: boolean;
  additions: number;
  deletions: number;
}
export interface CheckpointInfo {
  name: string;
  ref: string;
  commit: string;
  at: string;
  /** The first line of the commit that holds the saved state. */
  subject: string;
}
export interface BranchInfo {
  name: string;
  current: boolean;
  upstream: string | null;
  commit: string;
}
export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
  /** The main working tree of the repository. */
  main: boolean;
}

export interface GitOps {
  head(root: string, owner: string): Promise<string | undefined>;
  statusPaths(root: string, owner: string): Promise<StatusPaths>;
  /** Tracked files whose working-tree content differs from `commit`. */
  changesSince(root: string, owner: string, commit: string): Promise<FileChange[]>;
  /** The unified diff of one tracked path against `commit`. */
  diffFile(root: string, owner: string, commit: string, path: string): Promise<string>;
  /** Size in bytes of the file in `commit`, null if it did not exist there. */
  blobSize(root: string, owner: string, commit: string, path: string): Promise<number | null>;
  /** Which of the paths exist in `commit`. */
  existsIn(root: string, owner: string, commit: string, paths: string[]): Promise<Set<string>>;
  /** Writes these working-tree files back from `commit`. The index and every other file stay as they are. */
  restore(root: string, owner: string, commit: string, paths: string[]): Promise<void>;
  /** Stages and commits exactly these paths (anything else already staged stays staged). Returns the new commit. */
  commitPaths(root: string, owner: string, paths: string[], message: string): Promise<string>;
  /** Makes a new commit that undoes `commit`. On a conflict the revert is aborted and nothing is left half done. */
  revert(root: string, owner: string, commit: string): Promise<string>;
  isInHistory(root: string, owner: string, commit: string): Promise<boolean>;
  /** The first line of a commit's message. */
  subject(root: string, owner: string, commit: string): Promise<string>;
  checkpoints(root: string, owner: string): Promise<CheckpointInfo[]>;
  branches(root: string, owner: string): Promise<BranchInfo[]>;
  /** Paths Git tracks (the index), for counting binary assets. */
  trackedFiles(root: string, owner: string): Promise<string[]>;
  worktrees(root: string, owner: string): Promise<WorktreeInfo[]>;
  /** Adds a linked working tree on a new branch. Refuses an existing branch or a non-empty target. */
  addWorktree(root: string, owner: string, path: string, branch: string): Promise<void>;
  /** Removes a linked working tree. Git refuses when it has uncommitted changes; there is no force. */
  removeWorktree(root: string, owner: string, path: string): Promise<void>;
}

const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const MAX_STATUS_PATHS = 5000;
const SEPARATOR = '\u001f';

export function createGitOps(options: { runner: ProcessRunner; locate?: () => string | undefined }): GitOps {
  const shared = createGitExec(options.runner, options.locate ?? locateGit);
  const { needGit } = shared;
  // Each command gets its own owner id: the review screens ask for several at once, and the process runner refuses a second program for one owner.
  let counter = 0;
  const exec: typeof shared.exec = (git, root, owner, ...rest) => shared.exec(git, root, `${owner}#${++counter}`, ...rest);

  /** Runs one command in a repository; throws a plain AppError when it does not exit 0. */
  const run = async (root: string, owner: string, args: string[], what: string, write = false, timeoutMs = 30_000, maxBytes = 4 * 1024 * 1024) => {
    const git = needGit();
    const result = await exec(git, root, owner, ['--literal-pathspecs', ...args], write, timeoutMs, maxBytes);
    if (result.status !== 'exited' || result.exitCode !== 0)
      throw new AppError('TOOL_FAILED', `Git could not ${what}.`, { hint: (result.stderrTail.trim() || result.errorMessage || 'Details are in the log.').slice(0, 400), details: { exitCode: result.exitCode } });
    return result;
  };
  const checkCommit = (commit: string): void => {
    if (!COMMIT_ID.test(commit)) throw new AppError('INVALID_INPUT', 'That is not a full commit id.');
  };
  const checkPath = (path: string): void => {
    if (path === '' || path.includes('\0') || path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.split('/').includes('..')) throw new AppError('INVALID_INPUT', 'That is not a path inside the project.');
  };

  return {
    async head(root, owner) {
      const git = needGit();
      const result = await exec(git, root, owner, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      return result.exitCode === 0 ? result.stdoutTail.trim() : undefined;
    },

    async statusPaths(root, owner) {
      const out = (await run(root, owner, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], 'read the status')).stdoutTail;
      const tracked: StatusPaths['tracked'] = [];
      const untracked: string[] = [];
      for (const entry of out.split('\0')) {
        if (entry.length < 4) continue;
        const code = entry.slice(0, 2);
        const path = entry.slice(3);
        if (code === '??') untracked.push(path);
        else if (code !== '!!') tracked.push({ path, index: code[0] ?? ' ', worktree: code[1] ?? ' ' });
      }
      const truncated = tracked.length + untracked.length > MAX_STATUS_PATHS;
      return { tracked: tracked.slice(0, MAX_STATUS_PATHS), untracked: untracked.slice(0, MAX_STATUS_PATHS), truncated };
    },

    async changesSince(root, owner, commit) {
      checkCommit(commit);
      const names = (await run(root, owner, ['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', commit], 'list the changed files')).stdoutTail.split('\0');
      const stats = (await run(root, owner, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', commit], 'count the changed lines')).stdoutTail.split('\0');
      const counts = new Map<string, { binary: boolean; additions: number; deletions: number }>();
      for (const entry of stats) {
        const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry);
        if (match?.[3] !== undefined) counts.set(match[3], { binary: match[1] === '-', additions: Number(match[1]) || 0, deletions: Number(match[2]) || 0 });
      }
      const changes: FileChange[] = [];
      for (let i = 0; i + 1 < names.length; i += 2) {
        const code = names[i] ?? '';
        const path = names[i + 1] ?? '';
        if (path === '') continue;
        const count = counts.get(path) ?? { binary: false, additions: 0, deletions: 0 };
        changes.push({ path, status: code === 'A' ? 'added' : code === 'M' ? 'modified' : code === 'D' ? 'deleted' : 'other', ...count });
      }
      return changes;
    },

    async diffFile(root, owner, commit, path) {
      checkCommit(commit);
      checkPath(path);
      return (await run(root, owner, ['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U3', commit, '--', path], 'read the diff')).stdoutTail;
    },

    async blobSize(root, owner, commit, path) {
      checkCommit(commit);
      checkPath(path);
      const git = needGit();
      const result = await exec(git, root, owner, ['--literal-pathspecs', 'cat-file', '-s', `${commit}:${path}`]);
      return result.exitCode === 0 ? Number(result.stdoutTail.trim()) : null;
    },

    async existsIn(root, owner, commit, paths) {
      checkCommit(commit);
      for (const path of paths) checkPath(path);
      if (paths.length === 0) return new Set();
      const out = (await run(root, owner, ['ls-tree', '-r', '--name-only', '-z', commit, '--', ...paths], 'list the saved files')).stdoutTail;
      return new Set(out.split('\0').filter(Boolean));
    },

    async restore(root, owner, commit, paths) {
      checkCommit(commit);
      for (const path of paths) checkPath(path);
      if (paths.length === 0) return;
      await run(root, owner, ['restore', `--source=${commit}`, '--worktree', '--', ...paths], 'restore the files', true);
    },

    async commitPaths(root, owner, paths, message) {
      for (const path of paths) checkPath(path);
      if (paths.length === 0) throw new AppError('INVALID_INPUT', 'There is nothing to commit.');
      await run(root, owner, ['add', '--', ...paths], 'stage the files', true);
      await run(root, owner, ['commit', '--only', '-m', message, '--', ...paths], 'make the commit', true);
      const head = await this.head(root, owner);
      return head ?? '';
    },

    async revert(root, owner, commit) {
      checkCommit(commit);
      const parents = (await run(root, owner, ['rev-list', '--parents', '-n', '1', commit], 'read the commit')).stdoutTail.trim().split(/\s+/);
      if (parents.length > 2) throw new AppError('UNSUPPORTED', 'That is a merge commit, which needs a choice of side that this app does not make for you.', { hint: 'Revert it in a terminal.' });
      const git = needGit();
      const result = await exec(git, root, owner, ['revert', '--no-edit', commit], true, 30_000, 1024 * 1024);
      if (result.status !== 'exited' || result.exitCode !== 0) {
        await exec(git, root, owner, ['revert', '--abort'], true); // never leave a half-done revert behind
        throw new AppError('CONFLICT', 'Git could not revert that commit cleanly, so nothing was changed.', { hint: (result.stderrTail || result.stdoutTail).trim().slice(0, 400) });
      }
      return (await this.head(root, owner)) ?? '';
    },

    async isInHistory(root, owner, commit) {
      checkCommit(commit);
      const git = needGit();
      return (await exec(git, root, owner, ['merge-base', '--is-ancestor', commit, 'HEAD'])).exitCode === 0;
    },

    async subject(root, owner, commit) {
      checkCommit(commit);
      return (await run(root, owner, ['show', '-s', '--format=%s', commit], 'read the commit')).stdoutTail.trim().slice(0, 200);
    },

    async checkpoints(root, owner) {
      const out = (await run(root, owner, ['for-each-ref', '--sort=-committerdate', `--format=%(refname)${SEPARATOR}%(objectname)${SEPARATOR}%(committerdate:iso-strict)${SEPARATOR}%(subject)`, 'refs/gdcc/checkpoints'], 'list the checkpoints')).stdoutTail;
      return out
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [ref = '', commit = '', at = '', subject = ''] = line.split(SEPARATOR);
          return { name: ref.replace('refs/gdcc/checkpoints/', ''), ref, commit, at, subject };
        });
    },

    async branches(root, owner) {
      const out = (await run(root, owner, ['for-each-ref', `--format=%(refname:short)${SEPARATOR}%(HEAD)${SEPARATOR}%(upstream:short)${SEPARATOR}%(objectname:short)`, 'refs/heads'], 'list the branches')).stdoutTail;
      return out
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [name = '', head = '', upstream = '', commit = ''] = line.split(SEPARATOR);
          return { name, current: head === '*', upstream: upstream === '' ? null : upstream, commit };
        });
    },

    async trackedFiles(root, owner) {
      return (await run(root, owner, ['ls-files', '-z'], 'list the tracked files', false, 30_000, 8 * 1024 * 1024)).stdoutTail.split('\0').filter(Boolean);
    },

    async worktrees(root, owner) {
      const out = (await run(root, owner, ['worktree', 'list', '--porcelain'], 'list the working trees')).stdoutTail;
      const trees: WorktreeInfo[] = [];
      for (const block of out.split(/\r?\n\r?\n/)) {
        const lines = block.split(/\r?\n/);
        const path = lines.find((l) => l.startsWith('worktree '))?.slice(9);
        if (path === undefined) continue;
        const branch = lines.find((l) => l.startsWith('branch '))?.slice(7).replace('refs/heads/', '') ?? null;
        trees.push({ path, branch, head: (lines.find((l) => l.startsWith('HEAD ')) ?? '').slice(5), main: trees.length === 0 });
      }
      return trees;
    },

    async addWorktree(root, owner, path, branch) {
      if (!BRANCH_NAME.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) throw new AppError('INVALID_INPUT', 'A branch name uses letters, digits, dots, dashes, underscores and slashes.');
      await run(root, owner, ['worktree', 'add', '-b', branch, path], 'add the working tree', true);
    },

    async removeWorktree(root, owner, path) {
      await run(root, owner, ['worktree', 'remove', path], 'remove the working tree', true);
    },
  };
}
