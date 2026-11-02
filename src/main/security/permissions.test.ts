import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { removeTempDirs } from '../../../test/helpers/temp';
import { copyFixture } from '../../../test/helpers/tree';
import { createActivityLog, createRedactor } from '../logging';
import { createTaskService } from '../planning';
import { createProjectRegistry } from '../projects';
import { createPermissionService } from './permissions';

afterEach(removeTempDirs);

async function env() {
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const activity = createActivityLog({ db, redactor: createRedactor(), logger });
  const projects = createProjectRegistry({ db, activity, logger });
  const project = projects.add(copyFixture('audit-godot'));
  const tasks = createTaskService({ db, projects, activity, requirePlanApproval: () => false });
  const task = tasks.create({ projectId: project.id, title: 'Add jumping', description: '', provider: '', complexity: 'm', priority: 'normal' });
  const other = tasks.create({ projectId: project.id, title: 'Add dashing', description: '', provider: '', complexity: 'm', priority: 'normal' });
  const asked: { title: string; message: string; detail?: string | undefined }[] = [];
  const answer = { yes: true };
  const permissions = createPermissionService({
    db,
    projects,
    activity,
    confirm: (o) => {
      asked.push(o);
      return Promise.resolve(answer.yes);
    },
  });
  return { db, activity, project, task, other, tasks, permissions, asked, answer };
}

const failure = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a failure');
};

describe('permission scopes', () => {
  it('start with nothing granted: every project is read-only', async () => {
    const e = await env();
    expect(e.permissions.grants(e.project.id)).toEqual([]);
    expect(e.permissions.has(e.project.id, e.task.id, 'project-writes')).toBe(false);
    expect(e.permissions.has(e.project.id, null, 'project-writes')).toBe(false);
  });

  it('are granted only by a person answering the native window, which names the folder and what it allows', async () => {
    const e = await env();
    e.answer.yes = false;
    expect(await e.permissions.request({ projectId: e.project.id, scope: 'project-writes' })).toBeNull();
    expect(e.permissions.grants(e.project.id)).toEqual([]);
    expect(e.permissions.has(e.project.id, null, 'project-writes')).toBe(false);
    expect(e.asked[0]?.detail).toContain(e.project.rootPath);
    expect(e.asked[0]?.detail).toContain('cannot grant themselves');

    e.answer.yes = true;
    const grant = await e.permissions.request({ projectId: e.project.id, scope: 'project-writes' });
    expect(grant).toMatchObject({ scope: 'project-writes', taskId: null, where: e.project.rootPath, revokedAt: null });
    expect(e.permissions.has(e.project.id, e.task.id, 'project-writes')).toBe(true); // a project-wide grant covers its tasks
  });

  it('can be limited to one task: it covers that task and no other', async () => {
    const e = await env();
    const grant = await e.permissions.request({ projectId: e.project.id, taskId: e.task.id, scope: 'project-writes' });
    expect(grant).toMatchObject({ taskId: e.task.id, taskTitle: 'Add jumping' });
    expect(e.permissions.has(e.project.id, e.task.id, 'project-writes')).toBe(true);
    expect(e.permissions.has(e.project.id, e.other.id, 'project-writes')).toBe(false);
    expect(e.permissions.has(e.project.id, null, 'project-writes')).toBe(false);
  });

  it('are not asked for again while a grant already covers them', async () => {
    const e = await env();
    await e.permissions.request({ projectId: e.project.id, scope: 'project-writes' });
    const again = await e.permissions.request({ projectId: e.project.id, taskId: e.task.id, scope: 'project-writes' });
    expect(again).toMatchObject({ taskId: null });
    expect(e.asked).toHaveLength(1);
  });

  it('can be taken back at once, without a window, and then no longer apply', async () => {
    const e = await env();
    const grant = await e.permissions.request({ projectId: e.project.id, scope: 'project-writes' });
    const revoked = e.permissions.revoke(grant?.id ?? '');
    expect(revoked.revokedAt).not.toBeNull();
    expect(e.permissions.has(e.project.id, e.task.id, 'project-writes')).toBe(false);
    expect(e.asked).toHaveLength(1);
    // asking again is a new grant, with a new window
    await e.permissions.request({ projectId: e.project.id, scope: 'project-writes' });
    expect(e.asked).toHaveLength(2);
  });

  it('record what, where and when in the approvals log, and in the activity list', async () => {
    const e = await env();
    await e.permissions.request({ projectId: e.project.id, taskId: e.task.id, scope: 'project-writes' });
    const [entry] = e.permissions.approvals(e.project.id);
    expect(entry).toMatchObject({ scope: 'project-writes', taskId: e.task.id, where: e.project.rootPath });
    expect(entry?.what).toContain('Add jumping');
    expect(entry?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(e.activity.list({ kinds: ['permission.granted'], limit: 5 })).toHaveLength(1);
  });

  it('refuse a task of another project and a project that is gone', async () => {
    const e = await env();
    expect(await failure(e.permissions.request({ projectId: e.project.id, taskId: 'nope', scope: 'project-writes' }))).toMatchObject({ code: 'NOT_FOUND' });
    expect(await failure(e.permissions.request({ projectId: 'nope', scope: 'project-writes' }))).toMatchObject({ code: 'NOT_FOUND' });
    expect(e.asked).toEqual([]);
  });

  it('leave no way to grant without the window: the only insert into permissions is behind the confirmation', async () => {
    const e = await env();
    e.answer.yes = false;
    await e.permissions.request({ projectId: e.project.id, scope: 'project-writes' });
    expect(e.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM permissions')?.n).toBe(0);
    expect(Object.keys(e.permissions).sort()).toEqual(['approvals', 'grants', 'has', 'record', 'request', 'revoke']);
  });
});
