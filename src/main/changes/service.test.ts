import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { createGitOps, createGitService, locateGit } from '../git';
import { createActivityLog, createRedactor } from '../logging';
import { createAgentService, createTaskService } from '../planning';
import { createProcessRunner } from '../process';
import { createProjectRegistry } from '../projects';
import { createPermissionService } from '../security';
import { createChangeService } from './service';

afterEach(removeTempDirs);

const gitPath = locateGit();
const realGit = gitPath === undefined ? it.skip : it;
const KEY = 'sk-ant-api03-notreal0123456789abcdef';

/** A throwaway project in which the person already has unfinished work (keep.txt modified, scratch.txt untracked). */
async function env() {
  const dir = makeTempDir();
  const git = (...args: string[]): string => execFileSync(gitPath as string, ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.js'), 'one\ntwo\n');
  writeFileSync(join(dir, 'src', 'b.js'), 'bee\n');
  writeFileSync(join(dir, 'src', 'c.js'), 'sea\n');
  writeFileSync(join(dir, 'keep.txt'), 'keep\n');
  writeFileSync(join(dir, 'asset.bin'), Buffer.from([0, 1, 2, 3]));
  git('add', '.');
  git('commit', '-q', '-m', 'Start');
  writeFileSync(join(dir, 'keep.txt'), 'keep\nmy unfinished line\n'); // the person's uncommitted work
  writeFileSync(join(dir, 'src', 'c.js'), 'sea\nmy edit to c\n'); // also theirs, in a file the agent will touch too
  writeFileSync(join(dir, 'scratch.txt'), 'my scratch\n'); // untracked, theirs

  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const redactor = createRedactor();
  const activity = createActivityLog({ db, redactor, logger });
  const projects = createProjectRegistry({ db, activity, logger });
  const project = projects.add(dir);
  const tasks = createTaskService({ db, projects, activity, requirePlanApproval: () => false });
  const agents = createAgentService({ db, projects, tasks, activity });
  const task = tasks.create({ projectId: project.id, title: 'Raise the jump', description: '', provider: '', complexity: 'm', priority: 'normal' });
  const [runId] = agents.createWorkflow({ taskId: task.id, workflow: 'plan', includeReviewer: false, includeQa: false }).map((r) => r.id) as [string];
  const asked: { title: string; message: string; detail?: string | undefined }[] = [];
  const answer = { yes: true };
  const confirm = (o: { title: string; message: string; detail?: string }): Promise<boolean> => {
    asked.push(o);
    return Promise.resolve(answer.yes);
  };
  const permissions = createPermissionService({ db, projects, activity, confirm });
  const runner = createProcessRunner({ logger, redactor });
  const ops = createGitOps({ runner });
  const backupDir = join(makeTempDir(), 'rejected-changes');
  const changes = createChangeService({ db, projects, git: ops, permissions, activity, redactor, confirm, backupDir });
  const begin = async (): Promise<string> => {
    const saved = await createGitService({ runner, logger }).checkpoint(dir, 'test', 'before-run');
    return changes.begin({ runId, projectId: project.id, taskId: task.id, roleLabel: 'Implementer', checkpoint: saved });
  };
  return { dir, git, db, project, task, agents, runId, changes, permissions, asked, answer, begin, backupDir, activity };
}

/** What the "agent" does: edits two files, creates one, deletes one, writes a secret and a binary. */
function agentWorks(dir: string): void {
  writeFileSync(join(dir, 'src', 'a.js'), 'one\ntwo\nthree\n');
  writeFileSync(join(dir, 'src', 'c.js'), 'sea\nmy edit to c\nagent line\n');
  execFileSync(process.execPath, ['-e', `require('fs').rmSync(${JSON.stringify(join(dir, 'src', 'b.js'))})`]);
  writeFileSync(join(dir, 'src', 'new.js'), `export const key = '${KEY}';\nexport const x = 1;\n`);
  writeFileSync(join(dir, '.env'), `API_KEY=${KEY}\n`);
  writeFileSync(join(dir, 'asset.bin'), Buffer.from([0, 9, 9, 9, 9]));
}

const failure = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a failure');
};

describe('reviewing what an agent changed', () => {
  realGit('lists only the agent’s own changes, not the person’s earlier uncommitted work', async () => {
    const e = await env();
    const id = await e.begin();
    agentWorks(e.dir);
    const review = await e.changes.review(id);
    const byPath = new Map(review.files.map((f) => [f.path, f]));
    expect([...byPath.keys()].sort()).toEqual(['.env', 'asset.bin', 'src/a.js', 'src/b.js', 'src/c.js', 'src/new.js']);
    expect(byPath.has('keep.txt')).toBe(false); // modified before the run and untouched since
    expect(byPath.has('scratch.txt')).toBe(false); // untracked before the run
    expect(byPath.get('src/a.js')).toMatchObject({ status: 'modified', additions: 1, deletions: 0, overlap: false });
    expect(byPath.get('src/b.js')).toMatchObject({ status: 'deleted', sizeAfter: null });
    expect(byPath.get('src/new.js')).toMatchObject({ status: 'added', sizeBefore: null });
    expect(byPath.get('src/c.js')?.overlap).toBe(true); // the person had edited it first
    expect(review.session).toMatchObject({ status: 'open', roleLabel: 'Implementer', taskTitle: 'Raise the jump' });
  });

  realGit('shows accurate unified diffs for additions, changes and deletions, with secrets removed', async () => {
    const e = await env();
    const id = await e.begin();
    agentWorks(e.dir);
    const files = new Map((await e.changes.review(id)).files.map((f) => [f.path, f]));
    expect(files.get('src/a.js')?.diff).toContain('@@');
    expect(files.get('src/a.js')?.diff).toContain('+three');
    expect(files.get('src/a.js')?.diff).not.toContain('-one');
    expect(files.get('src/b.js')?.diff).toContain('-bee');
    const added = files.get('src/new.js');
    expect(added?.diff).toContain('--- /dev/null');
    expect(added?.diff).toContain('+export const x = 1;');
    expect(added?.diff).not.toContain(KEY);
    expect(added?.diff).toContain('[redacted]');
    expect(files.get('src/c.js')?.diff).toContain('+agent line');
    expect(files.get('src/c.js')?.diff).not.toContain('+my edit to c'); // the person’s own line is not the agent’s change
  });

  realGit('lists binary files with their sizes and a notice instead of a diff, and never shows a file that can hold secrets', async () => {
    const e = await env();
    const id = await e.begin();
    agentWorks(e.dir);
    const files = new Map((await e.changes.review(id)).files.map((f) => [f.path, f]));
    expect(files.get('asset.bin')).toMatchObject({ binary: true, diff: '', sizeBefore: 4, sizeAfter: 5 });
    expect(files.get('asset.bin')?.note).toContain('Binary file: 4 bytes before, 5 bytes now');
    expect(files.get('.env')).toMatchObject({ hidden: true, diff: '' });
    expect(files.get('.env')?.note).toContain('can hold secrets');
    expect(JSON.stringify(await e.changes.review(id))).not.toContain(KEY);
  });

  realGit('says so when nothing differs, and refuses an unknown session', async () => {
    const e = await env();
    const id = await e.begin();
    expect((await e.changes.review(id)).notes).toContain('Nothing differs from the state before the run.');
    expect(await failure(e.changes.review('nope'))).toMatchObject({ code: 'NOT_FOUND' });
    expect(e.changes.sessions(e.project.id)).toHaveLength(1);
  });
});

describe('approving', () => {
  realGit('commits exactly the agent’s files, leaves the person’s other work as it was, and never commits a file that can hold secrets', async () => {
    const e = await env();
    const id = await e.begin();
    agentWorks(e.dir);
    const result = await e.changes.approve(id);
    expect(result.committed).toBe(true);
    const committed = e.git('show', '--name-only', '--format=', 'HEAD').trim().split(/\r?\n/).sort();
    expect(committed).toEqual(['asset.bin', 'src/a.js', 'src/b.js', 'src/c.js', 'src/new.js']);
    expect(e.git('log', '-1', '--format=%s')).toContain('Agent changes: Implementer for "Raise the jump"');
    // the person's unfinished work is still unfinished, and .env was left out
    const status = e.git('status', '--porcelain').trimEnd().split(/\r?\n/).sort();
    expect(status).toEqual(['?? .env', '?? scratch.txt', ' M keep.txt'].sort());
    expect(readFileSync(join(e.dir, 'keep.txt'), 'utf8')).toBe('keep\nmy unfinished line\n');
    expect(e.git('show', 'HEAD:src/new.js')).toContain('export const x = 1;'); // the commit holds the real file, the screen only a redacted view
    // the window named the files, the overlap and the held file
    const detail = e.asked.at(-1)?.detail ?? '';
    expect(detail).toContain('modified src/a.js');
    expect(detail).toContain('your changes in them are committed too:\nsrc/c.js');
    expect(detail).toContain('Not committed, because they can hold secrets:\n.env');
    expect(e.changes.sessions(e.project.id)[0]).toMatchObject({ status: 'approved', commit: result.commit });
    expect(e.permissions.approvals(e.project.id)[0]?.what).toContain('Committed 5 files');
  });

  realGit('declining the window commits nothing, and an approved session cannot be approved or rejected again', async () => {
    const e = await env();
    const id = await e.begin();
    agentWorks(e.dir);
    const head = e.git('rev-parse', 'HEAD');
    e.answer.yes = false;
    expect(await e.changes.approve(id)).toEqual({ committed: false });
    expect(e.git('rev-parse', 'HEAD')).toBe(head);
    expect(e.changes.sessions(e.project.id)[0]?.status).toBe('open');
    e.answer.yes = true;
    await e.changes.approve(id);
    expect(await failure(e.changes.approve(id))).toMatchObject({ code: 'CONFLICT' });
    expect(await failure(e.changes.reject(id))).toMatchObject({ code: 'CONFLICT' });
  });

  realGit('refuses while the run is still working, and when only secret files changed', async () => {
    const e = await env();
    const id = await e.begin();
    writeFileSync(join(e.dir, '.env'), `X=${KEY}\n`);
    e.agents.transition(e.runId, 'planning', 'started');
    expect(await failure(e.changes.approve(id))).toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('still working') as unknown });
    expect(await failure(e.changes.reject(id))).toMatchObject({ code: 'CONFLICT' });
    e.agents.transition(e.runId, 'cancelled', 'stopped');
    expect(await failure(e.changes.approve(id))).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('could hold secrets') as unknown });
    expect(e.git('log', '--oneline').trim().split(/\r?\n/)).toHaveLength(1);
  });
});

describe('rejecting', () => {
  realGit('puts back only the agent’s files — as they were before the run, including the person’s own unfinished edits — and keeps a copy first', async () => {
    const e = await env();
    const id = await e.begin();
    agentWorks(e.dir);
    const result = await e.changes.reject(id);
    expect(result.rejected).toBe(true);
    expect(readFileSync(join(e.dir, 'src', 'a.js'), 'utf8')).toBe('one\ntwo\n');
    expect(readFileSync(join(e.dir, 'src', 'b.js'), 'utf8')).toBe('bee\n'); // the deleted file is back
    expect(readFileSync(join(e.dir, 'src', 'c.js'), 'utf8')).toBe('sea\nmy edit to c\n'); // the person's edit survives, the agent's line is gone
    expect(readFileSync(join(e.dir, 'asset.bin'))).toEqual(Buffer.from([0, 1, 2, 3]));
    expect(existsSync(join(e.dir, 'src', 'new.js'))).toBe(false); // created by the agent
    expect(existsSync(join(e.dir, '.env'))).toBe(false);
    // everything else of the person's is exactly as it was
    expect(readFileSync(join(e.dir, 'keep.txt'), 'utf8')).toBe('keep\nmy unfinished line\n');
    expect(readFileSync(join(e.dir, 'scratch.txt'), 'utf8')).toBe('my scratch\n');
    expect(e.git('stash', 'list')).toBe('');
    expect(e.git('log', '--oneline').trim().split(/\r?\n/)).toHaveLength(1);
    // a copy of what was there was kept
    expect(readFileSync(join(e.backupDir, id, 'src', 'a.js'), 'utf8')).toBe('one\ntwo\nthree\n');
    expect(readFileSync(join(e.backupDir, id, 'src', 'new.js'), 'utf8')).toContain('export const x = 1;');
    expect(existsSync(join(e.backupDir, id, '.env'))).toBe(false); // secrets are restored but never copied
    expect(result.savedTo).toBe(join(e.backupDir, id));
    expect(e.changes.sessions(e.project.id)[0]?.status).toBe('rejected');
    const detail = e.asked.at(-1)?.detail ?? '';
    expect(detail).toContain('Deleted, because the run created them:');
    expect(detail).toContain('A copy of what is there now is kept first');
  });

  realGit('declining the window changes nothing at all', async () => {
    const e = await env();
    const id = await e.begin();
    agentWorks(e.dir);
    const before = e.git('status', '--porcelain=v2');
    e.answer.yes = false;
    expect(await e.changes.reject(id)).toEqual({ rejected: false });
    expect(e.git('status', '--porcelain=v2')).toBe(before);
    expect(readFileSync(join(e.dir, 'src', 'a.js'), 'utf8')).toBe('one\ntwo\nthree\n');
    expect(existsSync(e.backupDir)).toBe(false);
  });

  realGit('stops before touching anything when a file is too large to keep a copy of', async () => {
    const e = await env();
    const id = await e.begin();
    writeFileSync(join(e.dir, 'huge.dat'), Buffer.alloc(51 * 1024 * 1024, 1));
    expect(await failure(e.changes.reject(id))).toMatchObject({ code: 'LIMIT_REACHED' });
    expect(existsSync(join(e.dir, 'huge.dat'))).toBe(true);
    rmSync(join(e.dir, 'huge.dat'));
  });
});

describe('reverting', () => {
  realGit('undoes an approved commit with a new commit and keeps the history', async () => {
    const e = await env();
    const id = await e.begin();
    writeFileSync(join(e.dir, 'src', 'a.js'), 'one\ntwo\nthree\n');
    const { commit } = await e.changes.approve(id);
    const result = await e.changes.revert(e.project.id, commit ?? '');
    expect(result.reverted).toBe(true);
    expect(readFileSync(join(e.dir, 'src', 'a.js'), 'utf8')).toBe('one\ntwo\n');
    expect(e.git('log', '--oneline').trim().split(/\r?\n/)).toHaveLength(3);
    expect(e.asked.at(-1)?.detail).toContain('nothing is reset or deleted');
  });

  realGit('refuses a commit that is not in the branch history, and a declined window changes nothing', async () => {
    const e = await env();
    const head = e.git('rev-parse', 'HEAD').trim();
    expect(await failure(e.changes.revert(e.project.id, 'a'.repeat(40)))).toMatchObject({ code: 'NOT_FOUND' });
    e.answer.yes = false;
    expect(await e.changes.revert(e.project.id, head)).toEqual({ reverted: false });
    expect(e.git('log', '--oneline').trim().split(/\r?\n/)).toHaveLength(1);
  });
});
