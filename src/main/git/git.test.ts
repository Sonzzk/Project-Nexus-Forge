import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

describe('git init and checkpoints (the two guarded writes)', () => {
  const setup = () => {
    const logger = memoryLogger();
    const runner = createProcessRunner({ logger, redactor: createRedactor() });
    return { service: createGitService({ runner, logger }) };
  };
  const repo = (): { dir: string; git: (...args: string[]) => string } => {
    const dir = makeTempDir();
    const git = (...args: string[]): string => execFileSync(gitPath as string, ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    // checkpoints commit as the configured user, so the repository needs one
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 't@example.com');
    return { dir, git };
  };

  realGit('creates a repository in a plain folder and nothing else', async () => {
    const { service } = setup();
    const dir = makeTempDir();
    writeFileSync(join(dir, 'a.txt'), 'one');
    expect(await service.init(dir, 'i1')).toEqual({ created: true });
    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one');
    expect(await service.summary(dir, 'i1b')).toMatchObject({ isRepository: true });
  });

  realGit('refuses a folder that already has a .git entry and leaves its configuration alone', async () => {
    const { service } = setup();
    const { dir, git } = repo();
    git('config', 'core.custom', 'keep-me');
    const before = snapshotTree(dir);
    await expect(service.init(dir, 'i2')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(snapshotTree(dir)).toEqual(before);
    expect(git('config', 'core.custom').trim()).toBe('keep-me');
  });

  realGit('refuses to nest a second repository inside an existing one', async () => {
    const { service } = setup();
    const { dir } = repo();
    const inner = join(dir, 'game');
    mkdirSync(inner);
    await expect(service.init(inner, 'i3')).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('already a Git repository') as unknown });
    expect(existsSync(join(inner, '.git'))).toBe(false);
  });

  realGit('a checkpoint names the saved state, includes uncommitted tracked changes, and changes no file, no index entry and no stash', async () => {
    const { service } = setup();
    const { dir, git } = repo();
    writeFileSync(join(dir, 'a.txt'), 'one');
    git('add', '.');
    git('commit', '-q', '-m', 'First');
    writeFileSync(join(dir, 'a.txt'), 'two'); // an uncommitted edit
    writeFileSync(join(dir, 'new.txt'), 'untracked');
    git('add', 'a.txt'); // and a staged one
    writeFileSync(join(dir, 'a.txt'), 'three');
    const before = snapshotTree(dir, { skip: ['.git'] });
    const status = git('status', '--porcelain=v2');
    const stashes = git('stash', 'list');

    const saved = await service.checkpoint(dir, 'c1', 'before-run-1');
    expect(saved).toMatchObject({ ref: 'refs/gdcc/checkpoints/before-run-1', includesUncommitted: true });
    expect(saved.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git('rev-parse', 'refs/gdcc/checkpoints/before-run-1').trim()).toBe(saved.commit);
    expect(snapshotTree(dir, { skip: ['.git'] })).toEqual(before);
    expect(git('status', '--porcelain=v2')).toBe(status);
    expect(git('stash', 'list')).toBe(stashes);
    expect(git('show', `${saved.commit}:a.txt`)).toBe('three');
  });

  realGit('a checkpoint of a clean tree points at the current commit', async () => {
    const { service } = setup();
    const { dir, git } = repo();
    writeFileSync(join(dir, 'a.txt'), 'one');
    git('add', '.');
    git('commit', '-q', '-m', 'First');
    const saved = await service.checkpoint(dir, 'c2', 'clean');
    expect(saved).toMatchObject({ includesUncommitted: false, commit: git('rev-parse', 'HEAD').trim() });
  });

  realGit('refuses a repeated name, a bad name and a repository without commits, and overwrites nothing', async () => {
    const { service } = setup();
    const { dir, git } = repo();
    await expect(service.checkpoint(dir, 'c3', 'first')).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('no commits yet') as unknown });
    writeFileSync(join(dir, 'a.txt'), 'one');
    git('add', '.');
    git('commit', '-q', '-m', 'First');
    const first = await service.checkpoint(dir, 'c4', 'first');
    writeFileSync(join(dir, 'a.txt'), 'two');
    await expect(service.checkpoint(dir, 'c5', 'first')).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('already exists') as unknown });
    expect(git('rev-parse', 'refs/gdcc/checkpoints/first').trim()).toBe(first.commit);
    for (const bad of ['', '../x', 'a b', '-rf', 'x'.repeat(81)]) await expect(service.checkpoint(dir, 'c6', bad)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('say so when Git is missing', async () => {
    const logger = memoryLogger();
    const service = createGitService({ runner: { start: () => { throw new Error('must not start'); } } as never, logger, locate: () => undefined });
    await expect(service.init(makeTempDir(), 'x')).rejects.toMatchObject({ code: 'TOOL_NOT_INSTALLED' });
    await expect(service.checkpoint(makeTempDir(), 'x', 'name')).rejects.toMatchObject({ code: 'TOOL_NOT_INSTALLED' });
  });
});
