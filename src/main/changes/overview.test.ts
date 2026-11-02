import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { createGitOps, createGitService, locateGit } from '../git';
import { createActivityLog, createRedactor } from '../logging';
import { createProcessRunner } from '../process';
import { createProjectRegistry } from '../projects';
import { createPermissionService } from '../security';
import { createOverviewService } from './overview';

afterEach(removeTempDirs);

const gitPath = locateGit();
const realGit = gitPath === undefined ? it.skip : it;

async function env(options: { repository?: boolean } = {}) {
  const dir = makeTempDir();
  const git = (...args: string[]): string => execFileSync(gitPath as string, ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  if (options.repository !== false) {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 't@example.com');
    git('add', '.');
    git('commit', '-q', '-m', 'Start');
  }
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const redactor = createRedactor();
  const activity = createActivityLog({ db, redactor, logger });
  const projects = createProjectRegistry({ db, activity, logger });
  const project = projects.add(dir);
  const answer = { yes: true };
  const asked: string[] = [];
  const confirm = (o: { title: string; message: string; detail?: string }): Promise<boolean> => (asked.push(`${o.title}\n${o.detail ?? ''}`), Promise.resolve(answer.yes));
  const permissions = createPermissionService({ db, projects, activity, confirm });
  const runner = createProcessRunner({ logger, redactor });
  const lock = { held: false };
  const worktreeDir = join(makeTempDir(), 'worktrees');
  const service = createOverviewService({ db, projects, git: createGitOps({ runner }), gitService: createGitService({ runner, logger }), permissions, activity, confirm, worktreeDir, writerLocked: () => lock.held });
  return { dir, git, project, service, answer, asked, lock, worktreeDir, permissions };
}

const failure = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a failure');
};

describe('the Git overview', () => {
  realGit('lists branches and named checkpoints, and records a checkpoint without any window', async () => {
    const e = await env();
    e.git('branch', 'feature');
    expect(await e.service.checkpoint(e.project.id, 'before-big-change')).toMatchObject({ name: 'before-big-change', ref: 'refs/gdcc/checkpoints/before-big-change' });
    const view = await e.service.overview(e.project.id);
    expect(view.branches.map((b) => [b.name, b.current])).toEqual([['feature', false], ['main', true]]);
    expect(view.checkpoints.map((c) => c.name)).toEqual(['before-big-change']);
    expect(e.asked).toEqual([]);
    expect(e.permissions.approvals(e.project.id)[0]?.what).toContain('before-big-change');
    expect(await failure(e.service.checkpoint(e.project.id, 'before-big-change'))).toMatchObject({ code: 'CONFLICT' });
    expect(await failure(e.service.checkpoint(e.project.id, '../x'))).toMatchObject({ code: 'INVALID_INPUT' });
  });

  realGit('always says what a checkpoint does not hold, and warns about binary assets without Git LFS', async () => {
    const e = await env();
    writeFileSync(join(e.dir, 'level.umap'), Buffer.alloc(3 * 1024 * 1024, 7));
    writeFileSync(join(e.dir, 'hero.uasset'), Buffer.alloc(1024, 7));
    e.git('add', '.');
    e.git('commit', '-q', '-m', 'Assets');
    const { protection } = await e.service.overview(e.project.id);
    expect(protection).toMatchObject({ lfs: false, binaryFiles: 2, largestBinaryMb: 3 });
    expect(protection.notes[0]).toContain('tracked files only');
    expect(protection.notes.join(' ')).toContain('without Git LFS');
    expect(protection.notes.join(' ')).toContain('not a real backup');
  });

  realGit('notices Git LFS and says its files live elsewhere', async () => {
    const e = await env();
    writeFileSync(join(e.dir, '.gitattributes'), '*.uasset filter=lfs diff=lfs merge=lfs -text\n');
    const { protection } = await e.service.overview(e.project.id);
    expect(protection.lfs).toBe(true);
    expect(protection.notes.join(' ')).toContain('LFS files live outside the repository');
    expect(protection.notes.join(' ')).not.toContain('without Git LFS');
  });

  realGit('explains instead of failing when the folder is not a repository', async () => {
    const e = await env({ repository: false });
    const view = await e.service.overview(e.project.id);
    expect(view).toMatchObject({ branches: [], checkpoints: [] });
    expect(view.note).toContain('not a Git repository');
  });
});

describe('working trees', () => {
  realGit('are created and removed only after a window, in the app’s own folder, and the project folder is untouched', async () => {
    const e = await env();
    const before = e.git('status', '--porcelain=v2', '--branch');
    e.answer.yes = false;
    expect(await e.service.addWorktree(e.project.id, 'dash')).toEqual({ created: false });
    expect((await e.service.overview(e.project.id)).worktrees).toEqual([]);

    e.answer.yes = true;
    expect(await e.service.addWorktree(e.project.id, 'dash')).toEqual({ created: true });
    expect(e.asked.at(-1)).toContain('cannot touch your project folder');
    const [tree] = (await e.service.overview(e.project.id)).worktrees;
    expect(tree).toMatchObject({ name: 'dash', branch: 'gdcc/dash', present: true });
    expect(tree?.path.startsWith(e.worktreeDir)).toBe(true);
    expect(readFileSync(join(tree?.path ?? '', 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('one\n'); // Git may check files out with Windows line endings
    expect(e.git('status', '--porcelain=v2', '--branch')).toBe(before);
    expect(existsSync(join(e.dir, 'dash'))).toBe(false);

    e.answer.yes = false;
    expect(await e.service.removeWorktree(tree?.id ?? '')).toEqual({ removed: false });
    expect(existsSync(tree?.path ?? '')).toBe(true);
    e.answer.yes = true;
    expect(await e.service.removeWorktree(tree?.id ?? '')).toEqual({ removed: true });
    expect(existsSync(tree?.path ?? '')).toBe(false);
    expect((await e.service.overview(e.project.id)).worktrees).toEqual([]);
    expect(e.git('branch', '--list', 'gdcc/dash')).toContain('gdcc/dash'); // the branch and its commits stay
  });

  realGit('are guarded: not while an agent holds the writer lock, not with a bad or repeated name, not for a tree the app did not create, and never forced', async () => {
    const e = await env();
    e.lock.held = true;
    expect(await failure(e.service.addWorktree(e.project.id, 'x'))).toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('writing to this project') as unknown });
    expect(e.asked).toEqual([]); // refused before any window
    e.lock.held = false;
    for (const bad of ['', '../x', 'a b', '-rf', 'x'.repeat(61)]) expect(await failure(e.service.addWorktree(e.project.id, bad))).toMatchObject({ code: 'INVALID_INPUT' });
    await e.service.addWorktree(e.project.id, 'one');
    expect(await failure(e.service.addWorktree(e.project.id, 'one'))).toMatchObject({ code: 'CONFLICT' });
    expect(await failure(e.service.removeWorktree('not-mine'))).toMatchObject({ code: 'NOT_FOUND' });

    const [tree] = (await e.service.overview(e.project.id)).worktrees;
    e.lock.held = true;
    expect(await failure(e.service.removeWorktree(tree?.id ?? ''))).toMatchObject({ code: 'CONFLICT' });
    e.lock.held = false;
    writeFileSync(join(tree?.path ?? '', 'a.txt'), 'uncommitted work\n');
    expect(await failure(e.service.removeWorktree(tree?.id ?? ''))).toMatchObject({ code: 'TOOL_FAILED' }); // Git refuses; no --force exists
    expect(readFileSync(join(tree?.path ?? '', 'a.txt'), 'utf8')).toBe('uncommitted work\n');
  });
});
