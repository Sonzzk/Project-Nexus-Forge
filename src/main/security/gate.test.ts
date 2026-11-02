import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitSummary } from '@shared/audit';
import { AppError } from '@shared/errors';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { snapshotTree } from '../../../test/helpers/tree';
import { createGitService, locateGit } from '../git';
import { createActivityLog, createRedactor } from '../logging';
import { createProcessRunner } from '../process';
import { createTaskService } from '../planning';
import { createProjectRegistry } from '../projects';
import { createWriteGate, describeTree } from './gate';
import { createPermissionService } from './permissions';

afterEach(removeTempDirs);

const gitPath = locateGit();
const realGit = gitPath === undefined ? it.skip : it;

/** A small throwaway code project, never a real one (spec §24 Phase 2). */
function throwaway(options: { commit?: boolean; repository?: boolean } = {}): { dir: string; git: (...args: string[]) => string } {
  const dir = makeTempDir();
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'package.json'), '{"name":"throwaway","scripts":{"test":"node -e 0"}}');
  writeFileSync(join(dir, 'src', 'index.js'), 'console.log("one");\n');
  const git = (...args: string[]): string => execFileSync(gitPath as string, ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  if (options.repository !== false) {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 't@example.com');
    if (options.commit !== false) {
      git('add', '.');
      git('commit', '-q', '-m', 'Start');
    }
  }
  return { dir, git };
}

async function env(dir: string, options: { files?: string[]; failCheckpoint?: boolean } = {}) {
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const activity = createActivityLog({ db, redactor: createRedactor(), logger });
  const projects = createProjectRegistry({ db, activity, logger });
  const project = projects.add(dir);
  const asked: { title: string; message: string; detail?: string | undefined }[] = [];
  const answer = { yes: true };
  const confirm = (o: { title: string; message: string; detail?: string }): Promise<boolean> => {
    asked.push(o);
    return Promise.resolve(answer.yes);
  };
  const tasks = createTaskService({ db, projects, activity, requirePlanApproval: () => false });
  const task = tasks.create({ projectId: project.id, title: 'Add jumping', description: '', provider: '', complexity: 'm', priority: 'normal', files: options.files ?? [] });
  const permissions = createPermissionService({ db, projects, activity, confirm });
  const runner = createProcessRunner({ logger, redactor: createRedactor() });
  const realService = createGitService({ runner, logger });
  const git = options.failCheckpoint === true ? { ...realService, checkpoint: () => Promise.reject(new AppError('TOOL_FAILED', 'Git could not save the current state.')) } : realService;
  const gate = createWriteGate({
    git,
    projects,
    permissions,
    activity,
    confirm,
    task: (id) => {
      const found = tasks.get(id);
      return { title: found.title, files: found.files };
    },
  });
  return { db, project, taskId: task.id, permissions, gate, asked, answer, activity };
}

const tree = (overrides: Partial<GitSummary> = {}): GitSummary => ({ available: true, isRepository: true, branch: 'main', changes: { staged: 0, modified: 0, untracked: 0, conflicted: 0 }, recentCommits: [{ hash: 'a', author: 'x', date: 'd', subject: 's' }], ...overrides });

describe('describeTree', () => {
  it('warns about uncommitted work and says nothing will be discarded', () => {
    const { warnings } = describeTree(tree({ changes: { staged: 1, modified: 2, untracked: 3, conflicted: 0 } }));
    expect(warnings[0]).toContain('uncommitted work (1 staged, 2 modified, 3 untracked)');
    expect(warnings[0]).toContain('Nothing will be stashed, reset or discarded for you');
  });

  it('is quiet about a clean tree, and says so', () => {
    expect(describeTree(tree())).toEqual({ lines: ['Branch: main', 'Uncommitted work: none.'], warnings: [] });
  });

  it('warns when Git is missing, when the folder is not a repository, on a conflict and on a repository without commits', () => {
    expect(describeTree({ available: false, isRepository: false }).warnings[0]).toContain('Git is not installed');
    expect(describeTree({ available: true, isRepository: false }).warnings[0]).toContain('not a Git repository');
    expect(describeTree(tree({ changes: { staged: 0, modified: 0, untracked: 0, conflicted: 1 } })).warnings.join(' ')).toContain('merge conflict');
    expect(describeTree(tree({ recentCommits: [] })).warnings.join(' ')).toContain('no commits yet');
  });
});

describe('the pre-write gate', () => {
  it('refuses until a person granted project writes; the grant, not the gate, is what allows a run', async () => {
    const { dir } = throwaway();
    const e = await env(dir);
    expect(() => e.gate.precheck({ projectId: e.project.id, taskId: e.taskId })).toThrow(expect.objectContaining({ code: 'PERMISSION_REQUIRED' }) as Error);
    await expect(e.gate.authorize({ runId: 'run-1', projectId: e.project.id, taskId: e.taskId, roleLabel: 'Implementer' })).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
    expect(e.asked).toEqual([]);
    await e.permissions.request({ projectId: e.project.id, taskId: e.taskId, scope: 'project-writes' });
    expect(() => e.gate.precheck({ projectId: e.project.id, taskId: e.taskId })).not.toThrow();
  });

  realGit('on a dirty tree it warns, saves a checkpoint of the tracked changes, and discards nothing', async () => {
    const { dir, git } = throwaway();
    writeFileSync(join(dir, 'src', 'index.js'), 'console.log("edited by me");\n');
    writeFileSync(join(dir, 'notes.txt'), 'untracked');
    const e = await env(dir, { files: ['src/index.js', 'src/player.js'] });
    await e.permissions.request({ projectId: e.project.id, scope: 'project-writes' });
    e.asked.length = 0;
    const before = snapshotTree(dir, { skip: ['.git'] });
    const status = git('status', '--porcelain=v2');

    const result = await e.gate.authorize({ runId: 'abcdef12-run', projectId: e.project.id, taskId: e.taskId, roleLabel: 'Implementer' });
    expect(result.approved).toBe(true);
    expect(result.checkpoint).toMatch(/^refs\/gdcc\/checkpoints\/before-abcdef12-/);

    const detail = e.asked[0]?.detail ?? '';
    expect(e.asked[0]?.title).toBe(`Let the Implementer change files in ${e.project.name}?`);
    expect(e.asked[0]?.message).toContain(dir);
    expect(detail).toContain('uncommitted work (1 modified, 1 untracked)');
    expect(detail).toContain('Nothing will be stashed, reset or discarded for you');
    expect(detail).toContain('src/index.js, src/player.js');
    expect(detail).toContain('A checkpoint of the current state is saved first');

    // the person's uncommitted work is exactly as it was, and the checkpoint holds it
    expect(snapshotTree(dir, { skip: ['.git'] })).toEqual(before);
    expect(git('status', '--porcelain=v2')).toBe(status);
    expect(git('show', `${result.checkpoint}:src/index.js`)).toContain('edited by me');
    expect(git('stash', 'list')).toBe('');

    const [entry] = e.permissions.approvals(e.project.id);
    expect(entry).toMatchObject({ scope: 'project-writes', taskId: e.taskId, runId: 'abcdef12-run', where: dir });
    expect(JSON.parse(entry?.detail ?? '{}')).toMatchObject({ branch: 'main', checkpoint: result.checkpoint, changes: { modified: 1, untracked: 1 } });
    expect(e.activity.list({ kinds: ['permission.write-approved'], limit: 3 })[0]?.severity).toBe('warning');
  });

  realGit('on a clean tree there is no warning, and a task without files says the scope is open', async () => {
    const { dir } = throwaway();
    const e = await env(dir);
    await e.permissions.request({ projectId: e.project.id, scope: 'project-writes' });
    e.asked.length = 0;
    await e.gate.authorize({ runId: 'run-2', projectId: e.project.id, taskId: e.taskId, roleLabel: 'Implementer' });
    expect(e.asked[0]?.detail).toContain('Uncommitted work: none.');
    expect(e.asked[0]?.detail).not.toContain('Warning:');
    expect(e.asked[0]?.detail).toContain('does not say which files');
    expect(e.asked[0]?.detail).toContain('Files that can hold secrets');
  });

  realGit('declining changes nothing: no checkpoint, no record, no change to any file', async () => {
    const { dir, git } = throwaway();
    const e = await env(dir);
    await e.permissions.request({ projectId: e.project.id, scope: 'project-writes' });
    const approvalsBefore = e.permissions.approvals(e.project.id).length;
    const refs = git('for-each-ref', 'refs/gdcc');
    const before = snapshotTree(dir);
    e.answer.yes = false;
    expect(await e.gate.authorize({ runId: 'run-3', projectId: e.project.id, taskId: e.taskId, roleLabel: 'Implementer' })).toEqual({ approved: false });
    expect(git('for-each-ref', 'refs/gdcc')).toBe(refs);
    expect(e.permissions.approvals(e.project.id)).toHaveLength(approvalsBefore);
    expect(snapshotTree(dir)).toEqual(before);
  });

  realGit('without Git history it still asks, warns, and saves no checkpoint', async () => {
    const { dir } = throwaway({ repository: false });
    const e = await env(dir);
    await e.permissions.request({ projectId: e.project.id, scope: 'project-writes' });
    e.asked.length = 0;
    const result = await e.gate.authorize({ runId: 'run-4', projectId: e.project.id, taskId: e.taskId, roleLabel: 'Implementer' });
    expect(result).toEqual({ approved: true });
    expect(e.asked[0]?.detail).toContain('not a Git repository');
    expect(e.asked[0]?.detail).toContain('No checkpoint can be saved');
  });

  realGit('a checkpoint that cannot be saved stops the run before anything is recorded or changed', async () => {
    const { dir } = throwaway();
    const e = await env(dir, { failCheckpoint: true });
    await e.permissions.request({ projectId: e.project.id, scope: 'project-writes' });
    const before = snapshotTree(dir);
    await expect(e.gate.authorize({ runId: 'run-6', projectId: e.project.id, taskId: e.taskId, roleLabel: 'Implementer' })).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    expect(e.permissions.approvals(e.project.id).filter((a) => a.runId === 'run-6')).toEqual([]);
    expect(snapshotTree(dir)).toEqual(before);
  });
});

describe('creating a Git repository', () => {
  realGit('explains the operation first, creates nothing when declined, and records it when accepted', async () => {
    const { dir } = throwaway({ repository: false });
    const e = await env(dir);
    e.answer.yes = false;
    expect(await e.gate.initGit(e.project.id)).toEqual({ created: false });
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(e.asked[0]?.detail).toContain('does not add, commit or change any of your files');
    expect(e.asked[0]?.detail).toContain('does not touch any Git settings');

    e.answer.yes = true;
    expect(await e.gate.initGit(e.project.id)).toEqual({ created: true });
    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(readFileSync(join(dir, 'src', 'index.js'), 'utf8')).toBe('console.log("one");\n');
    expect(e.permissions.approvals(e.project.id)[0]?.what).toContain('git init');
  });

  realGit('never overwrites an existing repository: it is refused after the question, with its configuration untouched', async () => {
    const { dir, git } = throwaway();
    git('config', 'core.custom', 'keep-me');
    const e = await env(dir);
    await expect(e.gate.initGit(e.project.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(git('config', 'core.custom').trim()).toBe('keep-me');
  });
});
