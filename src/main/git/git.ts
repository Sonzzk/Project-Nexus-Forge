import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { GitSummary } from '@shared/audit';
import { AppError } from '@shared/errors';
import type { Logger } from '../logging';
import type { ProcessRunner } from '../process';

// Git through the process runner (spec §7, §14). `summary` is read-only: branch, ahead and behind, uncommitted changes and
// recent commits, with `GIT_OPTIONAL_LOCKS=0` so `git status` does not refresh the index. Two operations write, both guarded:
// `init` (only in a folder with no .git entry, never touching any configuration) and `checkpoint` (a named reference to a
// commit that holds the current state, made without touching the working tree, the index or the stash list).

export interface Checkpoint {
  /** The reference that now names the saved state, for example `refs/gdcc/checkpoints/before-run`. */
  ref: string;
  commit: string;
  /** True when uncommitted changes to tracked files are in the checkpoint. Untracked files never are. */
  includesUncommitted: boolean;
}

export interface GitService {
  summary(root: string, ownerId: string): Promise<GitSummary>;
  /** Creates a repository in a folder that has none. Refuses when a .git entry exists or a parent folder is already a repository. */
  init(root: string, ownerId: string): Promise<{ created: true }>;
  /** Saves the current state under a name without changing any file. */
  checkpoint(root: string, ownerId: string, name: string): Promise<Checkpoint>;
}

export const CHECKPOINT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** Finds git.exe in the documented install folders and on PATH. Returns undefined when Git is not installed. */
export function locateGit(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates: string[] = [];
  for (const base of [env['ProgramFiles'], env['ProgramW6432'], env['ProgramFiles(x86)'], env['LOCALAPPDATA'] && join(env['LOCALAPPDATA'], 'Programs')]) {
    if (base === undefined || base === '') continue;
    candidates.push(join(base, 'Git', 'cmd', 'git.exe'), join(base, 'Git', 'bin', 'git.exe'));
  }
  for (const dir of (env['PATH'] ?? env['Path'] ?? '').split(delimiter)) if (dir !== '') candidates.push(join(dir, 'git.exe'));
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/** Parses `git status --porcelain=v2 --branch`. */
export function parseStatus(output: string): Pick<GitSummary, 'branch' | 'upstream' | 'ahead' | 'behind' | 'changes'> {
  let branch: string | undefined;
  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  const changes = { staged: 0, modified: 0, untracked: 0, conflicted: 0 };
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length);
    else if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length);
    else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4);
      if (xy[0] !== undefined && xy[0] !== '.') changes.staged++;
      if (xy[1] !== undefined && xy[1] !== '.') changes.modified++;
    } else if (line.startsWith('u ')) changes.conflicted++;
    else if (line.startsWith('? ')) changes.untracked++;
  }
  return {
    ...(branch === undefined ? {} : { branch }),
    ...(upstream === undefined ? {} : { upstream }),
    ...(ahead === undefined ? {} : { ahead }),
    ...(behind === undefined ? {} : { behind }),
    changes,
  };
}

const COMMIT_FORMAT = '%H%x1f%an%x1f%aI%x1f%s';

export function createGitService(options: { runner: ProcessRunner; logger: Logger; locate?: () => string | undefined }): GitService {
  const { runner, logger } = options;
  const locate = options.locate ?? locateGit;

  /** One Git command. `write` leaves out GIT_OPTIONAL_LOCKS=0, which is only for reading. */
  const exec = (git: string, root: string, ownerId: string, args: string[], write = false) =>
    runner.start({
      executable: git,
      args: ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', ...args],
      cwd: root,
      env: { ...(write ? {} : { GIT_OPTIONAL_LOCKS: '0' }), GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C' },
      timeoutMs: 15_000,
      maxOutputBytes: 1024 * 1024,
      purpose: `${write ? 'Run' : 'Read'} Git ${args[0] ?? ''}`,
      owner: { kind: 'git', id: ownerId },
    }).result;
  const needGit = (): string => {
    const git = locate();
    if (git === undefined) throw new AppError('TOOL_NOT_INSTALLED', 'Git was not found on this PC.', { hint: 'Install Git for Windows. The app never installs it for you.' });
    return git;
  };

  return {
    async init(root, ownerId) {
      const git = needGit();
      if (existsSync(join(root, '.git'))) throw new AppError('CONFLICT', 'This folder already has a .git entry, so nothing was created and its configuration was not touched.');
      const inside = await exec(git, root, ownerId, ['rev-parse', '--is-inside-work-tree']);
      if (inside.status === 'exited' && inside.exitCode === 0 && inside.stdoutTail.trim() === 'true')
        throw new AppError('CONFLICT', 'A folder above this one is already a Git repository, so a second one was not created inside it.');
      const made = await exec(git, root, ownerId, ['init'], true);
      if (made.status !== 'exited' || made.exitCode !== 0) throw new AppError('TOOL_FAILED', 'Git could not create the repository.', { hint: made.stderrTail.trim().slice(0, 300) || 'Details are in the log.' });
      return { created: true };
    },

    async checkpoint(root, ownerId, name) {
      if (!CHECKPOINT_NAME.test(name)) throw new AppError('INVALID_INPUT', 'A checkpoint name uses letters, digits, dots, dashes and underscores (up to 80 characters).');
      const git = needGit();
      const head = await exec(git, root, ownerId, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      if (head.exitCode !== 0) throw new AppError('CONFLICT', 'This repository has no commits yet, so there is nothing to save a checkpoint of.', { hint: 'Make a first commit, then try again.' });
      const ref = `refs/gdcc/checkpoints/${name}`;
      const exists = await exec(git, root, ownerId, ['rev-parse', '--verify', '--quiet', ref]);
      if (exists.exitCode === 0) throw new AppError('CONFLICT', `A checkpoint named "${name}" already exists.`, { hint: 'Choose another name. Checkpoints are never overwritten.' });
      // `stash create` builds a commit of the tracked changes without touching the working tree, the index or the stash list; it prints nothing when there are none.
      const stash = await exec(git, root, ownerId, ['stash', 'create'], true);
      if (stash.status !== 'exited' || stash.exitCode !== 0) throw new AppError('TOOL_FAILED', 'Git could not save the current state.', { hint: stash.stderrTail.trim().slice(0, 300) || 'Details are in the log.' });
      const saved = stash.stdoutTail.trim();
      const commit = saved !== '' ? saved : head.stdoutTail.trim();
      const made = await exec(git, root, ownerId, ['update-ref', ref, commit], true);
      if (made.exitCode !== 0) throw new AppError('TOOL_FAILED', 'Git could not record the checkpoint.', { hint: made.stderrTail.trim().slice(0, 300) || 'Details are in the log.' });
      return { ref, commit, includesUncommitted: saved !== '' };
    },

    async summary(root, ownerId) {
      const git = locate();
      if (git === undefined)
        return { available: false, isRepository: false, message: 'Git was not found on this PC. Install Git for Windows to see branch and change information.' };

      const run = (args: string[]) => exec(git, root, ownerId, args);

      const inside = await run(['rev-parse', '--is-inside-work-tree']);
      if (inside.status !== 'exited') return { available: true, isRepository: false, message: `Git did not answer (${inside.status}).` };
      if (inside.exitCode !== 0 || inside.stdoutTail.trim() !== 'true') {
        const stderr = inside.stderrTail;
        if (/dubious ownership/i.test(stderr))
          return { available: true, isRepository: false, message: 'Git refused to read this folder because it belongs to another user ("dubious ownership"). Nothing was changed.' };
        if (/not a git repository/i.test(stderr)) return { available: true, isRepository: false, message: 'Not a Git repository.' };
        logger.warn('git rev-parse failed', { exitCode: inside.exitCode, stderr: stderr.slice(0, 300) });
        return { available: true, isRepository: false, message: 'Git could not read this folder.' };
      }

      const status = await run(['status', '--porcelain=v2', '--branch']);
      const log = await run(['log', '-n', '10', `--format=${COMMIT_FORMAT}`]);
      const recentCommits = log.exitCode === 0
        ? log.stdoutTail
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => {
              const [hash = '', author = '', date = '', subject = ''] = line.split('\u001f');
              return { hash, author, date, subject };
            })
        : []; // a repository without commits yet has no log

      return {
        available: true,
        isRepository: true,
        ...(status.exitCode === 0 ? parseStatus(status.stdoutTail) : { message: 'Git could not report the status.' }),
        recentCommits,
      };
    },
  };
}
