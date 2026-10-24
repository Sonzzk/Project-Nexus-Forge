import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { GitSummary } from '@shared/audit';
import type { Logger } from '../logging';
import type { ProcessRunner } from '../process';

// Read-only Git (spec §7, §14): branch, ahead and behind, uncommitted changes and recent commits, through the process
// runner. Nothing here writes: `GIT_OPTIONAL_LOCKS=0` keeps `git status` from refreshing the index, and no command can
// change the repository. Write access comes with the permission gate in Step 15.

export interface GitService {
  summary(root: string, ownerId: string): Promise<GitSummary>;
}

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

  return {
    async summary(root, ownerId) {
      const git = locate();
      if (git === undefined)
        return { available: false, isRepository: false, message: 'Git was not found on this PC. Install Git for Windows to see branch and change information.' };

      const run = async (args: string[]) => {
        const handle = runner.start({
          executable: git,
          args: ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', ...args],
          cwd: root,
          env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C' },
          timeoutMs: 15_000,
          maxOutputBytes: 1024 * 1024,
          purpose: `Read Git ${args[0] ?? ''}`,
          owner: { kind: 'git', id: ownerId },
        });
        return handle.result;
      };

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
