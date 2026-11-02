import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryLogger } from '../../../test/helpers/logger';
import { makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { createRedactor } from '../logging';
import { createProcessRunner } from '../process';
import { createGitService, locateGit } from './git';
import { createGitOps } from './ops';

afterEach(removeTempDirs);

const gitPath = locateGit();
const realGit = gitPath === undefined ? it.skip : it;

function repo() {
  const dir = makeTempDir();
  const git = (...args: string[]): string => execFileSync(gitPath as string, ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false'); // files are compared byte for byte
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.js'), 'one\n');
  writeFileSync(join(dir, 'src', 'b.js'), 'bee\n');
  writeFileSync(join(dir, 'keep.txt'), 'keep\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Start');
  const logger = memoryLogger();
  const runner = createProcessRunner({ logger, redactor: createRedactor() });
  return { dir, git, ops: createGitOps({ runner }), service: createGitService({ runner, logger }) };
}

describe('reading what changed', () => {
  realGit('lists tracked files that differ from a saved commit and new untracked files, with line counts', async () => {
    const { dir, ops, service } = repo();
    writeFileSync(join(dir, 'src', 'a.js'), 'one\ntwo\n');
    const saved = await service.checkpoint(dir, 'c', 'base');
    writeFileSync(join(dir, 'src', 'a.js'), 'one\ntwo\nthree\n'); // modified after the checkpoint
    writeFileSync(join(dir, 'src', 'new.js'), 'new\n'); // untracked
    const changes = await ops.changesSince(dir, 'o1', saved.commit);
    expect(changes).toContainEqual({ path: 'src/a.js', status: 'modified', binary: false, additions: 1, deletions: 0 });
    expect(changes.map((c) => c.path)).toEqual(['src/a.js']);
    const status = await ops.statusPaths(dir, 'o2');
    expect(status.untracked).toEqual(['src/new.js']);
    expect(status.tracked.map((t) => t.path)).toEqual(['src/a.js']);
  });

  realGit('gives the unified diff of one file, the size it had, and marks binary files', async () => {
    const { dir, git, ops } = repo();
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    git('add', '.');
    git('commit', '-q', '-m', 'Add blob');
    const base = (await ops.head(dir, 'o3')) as string;
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 9, 9, 9, 0, 255, 7]));
    writeFileSync(join(dir, 'src', 'a.js'), 'uno\n');
    const changes = await ops.changesSince(dir, 'o4', base);
    expect(changes.find((c) => c.path === 'blob.bin')).toMatchObject({ binary: true, status: 'modified' });
    const diff = await ops.diffFile(dir, 'o5', base, 'src/a.js');
    expect(diff).toContain('-one');
    expect(diff).toContain('+uno');
    expect(await ops.blobSize(dir, 'o6', base, 'blob.bin')).toBe(6);
    expect(await ops.blobSize(dir, 'o6', base, 'nope.txt')).toBeNull();
  });

  realGit('treats a path as a literal file name, never an option or a pattern', async () => {
    const { dir, ops } = repo();
    const base = (await ops.head(dir, 'o7')) as string;
    await expect(ops.diffFile(dir, 'o8', base, '../outside')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(ops.diffFile(dir, 'o8', base, 'C:/x')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(ops.diffFile(dir, 'o8', 'HEAD', 'src/a.js')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    writeFileSync(join(dir, '--stat'), 'odd\n');
    expect((await ops.statusPaths(dir, 'o9')).untracked).toContain('--stat');
    expect(await ops.existsIn(dir, 'o10', base, ['*', ':(top)src/a.js', 'src/a.js'])).toEqual(new Set(['src/a.js']));
  });
});

describe('putting files back', () => {
  realGit('restores only the named files from the saved commit and leaves every other file, the index and the stash alone', async () => {
    const { dir, git, ops, service } = repo();
    writeFileSync(join(dir, 'keep.txt'), 'my own edit\n'); // the person's uncommitted work, saved in the checkpoint
    const saved = await service.checkpoint(dir, 'c', 'base');
    writeFileSync(join(dir, 'src', 'a.js'), 'agent edit\n');
    writeFileSync(join(dir, 'keep.txt'), 'my own edit\nand more after\n');
    git('add', 'keep.txt');
    const indexBefore = git('ls-files', '--stage');
    await ops.restore(dir, 'r1', saved.commit, ['src/a.js']);
    expect(readFileSync(join(dir, 'src', 'a.js'), 'utf8')).toBe('one\n');
    expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('my own edit\nand more after\n');
    expect(git('ls-files', '--stage')).toBe(indexBefore);
    expect(git('stash', 'list')).toBe('');
    // a file the person had changed before the run comes back as they had it, not as the last commit has it
    writeFileSync(join(dir, 'keep.txt'), 'agent wrecked it\n');
    await ops.restore(dir, 'r2', saved.commit, ['keep.txt']);
    expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('my own edit\n');
  });

  realGit('commits exactly the named paths and leaves other staged and unstaged work where it was', async () => {
    const { dir, git, ops } = repo();
    writeFileSync(join(dir, 'src', 'a.js'), 'agent\n');
    writeFileSync(join(dir, 'src', 'new.js'), 'brand new\n');
    writeFileSync(join(dir, 'keep.txt'), 'staged by me\n');
    git('add', 'keep.txt');
    writeFileSync(join(dir, 'src', 'b.js'), 'unstaged by me\n');
    const commit = await ops.commitPaths(dir, 'k1', ['src/a.js', 'src/new.js'], 'Agent changes');
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git('show', '--name-only', '--format=', 'HEAD').trim().split(/\r?\n/).sort()).toEqual(['src/a.js', 'src/new.js']);
    expect(git('status', '--porcelain').trim().split(/\r?\n/).sort()).toEqual([' M src/b.js', 'M  keep.txt']);
    expect(git('log', '-1', '--format=%s')).toBe('Agent changes\n');
  });

  realGit('commits a deletion too', async () => {
    const { dir, git, ops } = repo();
    execFileSync('cmd', ['/c', 'del', join(dir, 'src', 'b.js')]);
    await ops.commitPaths(dir, 'k2', ['src/b.js'], 'Remove b');
    expect(git('ls-files').split(/\r?\n/)).not.toContain('src/b.js');
  });
});

describe('reverting', () => {
  realGit('makes a new commit that undoes an old one and keeps the history', async () => {
    const { dir, git, ops } = repo();
    writeFileSync(join(dir, 'src', 'a.js'), 'changed\n');
    const bad = await ops.commitPaths(dir, 'v1', ['src/a.js'], 'A change');
    const before = git('rev-list', '--count', 'HEAD').trim();
    const reverted = await ops.revert(dir, 'v2', bad);
    expect(readFileSync(join(dir, 'src', 'a.js'), 'utf8')).toBe('one\n');
    expect(git('rev-list', '--count', 'HEAD').trim()).toBe(String(Number(before) + 1));
    expect(git('log', '-1', '--format=%H').trim()).toBe(reverted);
    expect(git('cat-file', '-t', bad).trim()).toBe('commit'); // the original is still there
    expect(await ops.isInHistory(dir, 'v3', bad)).toBe(true);
  });

  realGit('aborts a revert that conflicts and leaves the tree exactly as it was', async () => {
    const { dir, git, ops } = repo();
    writeFileSync(join(dir, 'src', 'a.js'), 'first\n');
    const first = await ops.commitPaths(dir, 'v4', ['src/a.js'], 'First');
    writeFileSync(join(dir, 'src', 'a.js'), 'second\n');
    await ops.commitPaths(dir, 'v5', ['src/a.js'], 'Second');
    await expect(ops.revert(dir, 'v6', first)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(readFileSync(join(dir, 'src', 'a.js'), 'utf8')).toBe('second\n'); // content, not timestamps: Git rewrote and restored the file
    expect(git('status', '--porcelain')).toBe('');
    expect(existsSync(join(dir, '.git', 'REVERT_HEAD'))).toBe(false);
  });

  realGit('refuses a merge commit and a commit id that is not a full hash', async () => {
    const { dir, git, ops } = repo();
    git('checkout', '-q', '-b', 'side');
    writeFileSync(join(dir, 'side.txt'), 's\n');
    git('add', '.');
    git('commit', '-q', '-m', 'Side');
    git('checkout', '-q', 'main');
    writeFileSync(join(dir, 'main.txt'), 'm\n');
    git('add', '.');
    git('commit', '-q', '-m', 'Main');
    git('merge', '-q', '--no-ff', '-m', 'Merge', 'side');
    const merge = git('rev-parse', 'HEAD').trim();
    await expect(ops.revert(dir, 'v7', merge)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(ops.revert(dir, 'v8', 'HEAD')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(ops.revert(dir, 'v9', '--no-edit')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('listing and working trees', () => {
  realGit('lists checkpoints newest first and the branches with the current one marked', async () => {
    const { dir, git, ops, service } = repo();
    await service.checkpoint(dir, 'l1', 'first');
    writeFileSync(join(dir, 'keep.txt'), 'changed\n');
    await service.checkpoint(dir, 'l2', 'second');
    git('branch', 'feature');
    const checkpoints = await ops.checkpoints(dir, 'l3');
    expect(checkpoints.map((c) => c.name).sort()).toEqual(['first', 'second']);
    expect(checkpoints[0]).toMatchObject({ ref: expect.stringMatching(/^refs\/gdcc\/checkpoints\//) as unknown, commit: expect.stringMatching(/^[0-9a-f]{40}$/) as unknown });
    const branches = await ops.branches(dir, 'l4');
    expect(branches.map((b) => [b.name, b.current])).toEqual([['feature', false], ['main', true]]);
  });

  realGit('adds and removes a linked working tree, and git itself refuses to remove one with uncommitted work', async () => {
    const { dir, ops } = repo();
    const path = join(makeTempDir(), 'wt');
    await ops.addWorktree(dir, 'w1', path, 'task/dash');
    expect(existsSync(join(path, 'keep.txt'))).toBe(true);
    const listed = await ops.worktrees(dir, 'w2');
    expect(listed).toHaveLength(2);
    expect(listed[1]).toMatchObject({ branch: 'task/dash', main: false });
    writeFileSync(join(path, 'keep.txt'), 'dirty\n');
    await expect(ops.removeWorktree(dir, 'w3', path)).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    expect(readFileSync(join(path, 'keep.txt'), 'utf8')).toBe('dirty\n');
    writeFileSync(join(path, 'keep.txt'), 'keep\n');
    await ops.removeWorktree(dir, 'w4', path);
    expect(existsSync(path)).toBe(false);
    await expect(ops.addWorktree(dir, 'w5', join(makeTempDir(), 'x'), '--bad')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
