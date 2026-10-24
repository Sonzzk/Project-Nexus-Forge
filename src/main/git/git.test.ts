import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryLogger } from '../../../test/helpers/logger';
import { makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { snapshotTree } from '../../../test/helpers/tree';
import { createRedactor } from '../logging';
import { createProcessRunner } from '../process';
import { createGitService, locateGit, parseStatus } from './git';

afterEach(removeTempDirs);

const gitPath = locateGit();
const realGit = gitPath === undefined ? it.skip : it;

const STATUS = [
  '# branch.oid 1234',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -1',
  '1 M. N... 100644 100644 100644 aaa bbb staged.txt',
  '1 .M N... 100644 100644 100644 aaa bbb modified.txt',
  '1 MM N... 100644 100644 100644 aaa bbb both.txt',
  '2 R. N... 100644 100644 100644 aaa bbb R100 new.txt\told.txt',
  'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
  '? untracked.txt',
  '? also-untracked.txt',
].join('\n');

describe('parseStatus', () => {
  it('reads branch, upstream, ahead and behind, and counts every kind of change', () => {
    expect(parseStatus(STATUS)).toEqual({
      branch: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      changes: { staged: 3, modified: 2, untracked: 2, conflicted: 1 },
    });
  });

  it('handles a branch without upstream and a detached HEAD', () => {
    expect(parseStatus('# branch.head (detached)\n')).toEqual({ branch: '(detached)', changes: { staged: 0, modified: 0, untracked: 0, conflicted: 0 } });
  });
});

describe('createGitService', () => {
  const setup = () => {
    const logger = memoryLogger();
    const runner = createProcessRunner({ logger, redactor: createRedactor() });
    return { logger, runner };
  };

  it('says so when Git is not installed, without starting anything', async () => {
    const { logger } = setup();
    const service = createGitService({
      runner: { start: () => { throw new Error('must not start'); } } as never,
      logger,
      locate: () => undefined,
    });
    const summary = await service.summary(makeTempDir(), 'o1');
    expect(summary).toMatchObject({ available: false, isRepository: false });
    expect(summary.message).toMatch(/Git was not found/);
  });

  realGit('reports "Not a Git repository." for a plain folder instead of failing', async () => {
    const { logger, runner } = setup();
    const dir = makeTempDir();
    // The temp folder sits under the system temp directory, which is not inside a repository.
    const summary = await createGitService({ runner, logger }).summary(dir, 'o2');
    expect(summary).toMatchObject({ available: true, isRepository: false, message: 'Not a Git repository.' });
  });

  realGit('reads branch, changes and recent commits of a real repository and changes nothing in it', async () => {
    const { logger, runner } = setup();
    const dir = makeTempDir();
    const git = (...args: string[]): string =>
      execFileSync(gitPath as string, ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.txt'), 'one');
    git('add', '.');
    git('commit', '-q', '-m', 'First commit');
    writeFileSync(join(dir, 'a.txt'), 'two');
    writeFileSync(join(dir, 'b.txt'), 'new');
    const before = snapshotTree(dir);

    const summary = await createGitService({ runner, logger }).summary(dir, 'o3');
    expect(summary).toMatchObject({ available: true, isRepository: true, branch: 'main', changes: { staged: 0, modified: 1, untracked: 1, conflicted: 0 } });
    expect(summary.recentCommits).toHaveLength(1);
    expect(summary.recentCommits?.[0]).toMatchObject({ author: 'Test', subject: 'First commit' });
    expect(summary.recentCommits?.[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshotTree(dir)).toEqual(before); // includes .git: a status call must not refresh the index
  });

  realGit('handles a repository with no commits yet', async () => {
    const { logger, runner } = setup();
    const dir = makeTempDir();
    execFileSync(gitPath as string, ['init', '-q', '-b', 'main'], { cwd: dir });
    const summary = await createGitService({ runner, logger }).summary(dir, 'o4');
    expect(summary).toMatchObject({ isRepository: true, branch: 'main', recentCommits: [] });
  });
});
