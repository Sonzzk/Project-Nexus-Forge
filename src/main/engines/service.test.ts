import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import { createFakeRunner } from '../../../test/helpers/fake-runner';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { removeTempDirs } from '../../../test/helpers/temp';
import { copyFixture, snapshotTree } from '../../../test/helpers/tree';
import { createActivityLog, createRedactor } from '../logging';
import { createProjectRegistry } from '../projects';
import { createPermissionService } from '../security';
import { createEngineService } from './service';

afterEach(removeTempDirs);

async function env(options: { registry?: string } = {}) {
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const redactor = createRedactor();
  const activity = createActivityLog({ db, redactor, logger });
  const projects = createProjectRegistry({ db, activity, logger });
  const asked: { title: string; detail?: string | undefined }[] = [];
  const answer = { yes: true };
  const confirm = (o: { title: string; message: string; detail?: string }): Promise<boolean> => (asked.push(o), Promise.resolve(answer.yes));
  const permissions = createPermissionService({ db, projects, activity, confirm });
  const opened: string[] = [];
  const picked: { path: string | undefined } = { path: undefined };
  const runner = createFakeRunner((spec) => (spec.executable.toLowerCase().endsWith('reg.exe') ? (options.registry === undefined ? { exitCode: 1, stderr: 'ERROR: The system was unable to find the specified registry key or value.' } : { stdout: options.registry }) : {}));
  const service = createEngineService({
    db,
    projects,
    runner,
    activity,
    permissions,
    confirm,
    logger,
    openPath: (full) => (opened.push(full), Promise.resolve('')),
    pickFolder: () => Promise.resolve(picked.path),
    env: () => ({ SystemRoot: process.env['SystemRoot'] ?? 'C:\\Windows', ProgramData: join(copyFixture('empty-custom'), 'no-programdata'), ProgramFiles: join(copyFixture('empty-custom'), 'no-programfiles') }),
  });
  const addEngine = async (): Promise<string> => {
    picked.path = copyFixture('engines/UE_5.5');
    await service.addEnginePath();
    return picked.path;
  };
  return { db, projects, service, asked, answer, opened, picked, addEngine, permissions, activity, runner };
}

const failure = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a failure');
};

describe('the Unreal view of a project', () => {
  it('describes a C++ project, finds the engine it asks for, offers its build commands, and reports each capability honestly', async () => {
    const e = await env();
    const root = copyFixture('unreal-cpp');
    const project = e.projects.add(root);
    const engine = await e.addEngine();
    const view = await e.service.view(project.id);
    expect(view.isUnreal).toBe(true);
    expect(view.project).toMatchObject({ name: 'Backrooms', engineAssociation: '5.5', hasSource: true });
    expect(view.engines).toMatchObject([{ version: '5.5.4', complete: true, source: 'configured', path: engine }]);
    expect(view.resolved).toMatchObject({ path: engine, how: expect.stringContaining('EngineAssociation 5.5') as unknown });
    expect(view.commands.map((c) => c.label)).toEqual(['Unreal: build Backrooms (Win64, Development)', 'Unreal: build BackroomsEditor (Win64, Development)']);
    expect(view.commands.every((c) => c.writes)).toBe(true);
    const states = Object.fromEntries(view.capabilities.map((c) => [c.id, c.state]));
    expect(states).toEqual({ detect: 'implemented', engines: 'implemented', open: 'implemented', build: 'implemented', logs: 'implemented', context: 'implemented', templates: 'implemented', 'automation-tests': 'unavailable', 'editor-python': 'experimental-off' });
  });

  it('says why a build is not possible: the engine it asks for is not installed, or the project has no C++', async () => {
    const e = await env();
    const cpp = e.projects.add(copyFixture('unreal-cpp'));
    const noEngine = await e.service.view(cpp.id);
    expect(noEngine.resolved).toBeNull();
    expect(noEngine.commands).toEqual([]);
    expect(noEngine.capabilities.find((c) => c.id === 'engines')).toMatchObject({ state: 'awaiting-configuration' });
    expect(noEngine.capabilities.find((c) => c.id === 'build')).toMatchObject({ state: 'awaiting-configuration', reason: expect.stringContaining('asks for engine 5.5') as unknown });

    const bp = e.projects.add(copyFixture('unreal-blueprint'));
    const blueprint = await e.service.view(bp.id);
    expect(blueprint.capabilities.find((c) => c.id === 'build')).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('Blueprint-only') as unknown });
    expect(blueprint.resolveNote).toContain('source build id');
  });

  it('handles a project that is not Unreal and an install that is not there, without failing', async () => {
    const e = await env();
    const other = e.projects.add(copyFixture('plain-web'));
    const view = await e.service.view(other.id);
    expect(view).toMatchObject({ isUnreal: false, project: null, commands: [] });
    expect(view.capabilities.find((c) => c.id === 'detect')).toMatchObject({ state: 'unavailable' });
    expect(await failure(e.service.view('missing'))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reads source builds from the registry listing and gives them the id the project names', async () => {
    const e = await env({ registry: `\r\nHKEY_CURRENT_USER\\Software\\Epic Games\\Unreal Engine\\Builds\r\n    {11111111-2222-3333-4444-555555555555}    REG_SZ    ${copyFixture('engines/UE_5.5')}\r\n` });
    const bp = e.projects.add(copyFixture('unreal-blueprint'));
    const view = await e.service.view(bp.id);
    expect(view.engines).toMatchObject([{ id: '{11111111-2222-3333-4444-555555555555}', source: 'registry' }]);
    expect(view.resolved?.how).toContain('registered source build');
    expect(e.runner.started.filter((s) => (s.args as string[])[0] === 'query')).toHaveLength(2); // both spellings of the key, one program each
    expect(new Set(e.runner.started.map((s) => s.owner.id)).size).toBe(e.runner.started.length);
  });

  it('offers the commands to the command service from its last look at the engines, and nothing before that', async () => {
    const e = await env();
    const project = e.projects.add(copyFixture('unreal-cpp'));
    await e.addEngine();
    expect(e.service.commandsFor(project.id)).toEqual([]); // no look yet (adding a path clears the cache)
    await e.service.view(project.id);
    const [build, editor] = e.service.commandsFor(project.id);
    expect(build?.argv.slice(1)).toEqual(['Backrooms', 'Win64', 'Development', `-Project=${join(project.rootPath, 'Backrooms.uproject')}`, '-WaitMutex']);
    expect(build?.argv[0]).toMatch(/Build\.bat$/);
    expect(editor?.label).toContain('BackroomsEditor');
    expect(build?.body).toContain('It does not change Source, Config or Content');
  });
});

describe('opening', () => {
  it('opens the project only after the window, through Windows, and records it; declining opens nothing', async () => {
    const e = await env();
    const project = e.projects.add(copyFixture('unreal-cpp'));
    e.answer.yes = false;
    expect(await e.service.open(project.id, 'project')).toEqual({ opened: false });
    expect(e.opened).toEqual([]);
    e.answer.yes = true;
    expect(await e.service.open(project.id, 'project')).toEqual({ opened: true });
    expect(e.opened).toEqual([join(project.rootPath, 'Backrooms.uproject')]);
    expect(e.asked.at(-1)?.detail).toContain('will not close it');
    expect(e.asked.at(-1)?.detail).toContain('asks for engine 5.5'); // the engine is missing, and the window says so
    expect(e.permissions.approvals(project.id)[0]?.what).toContain('Opened Backrooms.uproject');
  });

  it('opens folders without a window, only inside the project, and refuses what does not exist', async () => {
    const e = await env();
    const root = copyFixture('unreal-cpp');
    const project = e.projects.add(root);
    for (const target of ['source', 'config', 'content', 'plugins'] as const) await e.service.open(project.id, target);
    expect(e.opened).toEqual([join(root, 'Source'), join(root, 'Config'), join(root, 'Content'), join(root, 'Plugins')]);
    expect(e.asked).toEqual([]);
    expect(await failure(e.service.open(project.id, 'logs'))).toMatchObject({ code: 'NOT_FOUND' }); // no Saved\Logs yet
    expect(await failure(e.service.open(project.id, 'engine'))).toMatchObject({ code: 'NOT_FOUND' });
    expect(await failure(e.service.open(project.id, 'desktop' as never))).toMatchObject({ code: 'INVALID_INPUT' });
    await e.addEngine();
    expect(await e.service.open(project.id, 'engine')).toEqual({ opened: true });
  });

  it('refuses to open an Unreal target of a project that is not Unreal', async () => {
    const e = await env();
    const other = e.projects.add(copyFixture('plain-web'));
    expect(await failure(e.service.open(other.id, 'project'))).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('engine folders you add', () => {
  it('are added only from the folder window, only if they contain Engine, and removed by position without touching the disk', async () => {
    const e = await env();
    const root = copyFixture('engines/UE_5.5');
    const before = snapshotTree(root);
    e.picked.path = undefined;
    expect(await e.service.addEnginePath()).toEqual({ added: false });
    e.picked.path = copyFixture('empty-custom');
    expect(await failure(e.service.addEnginePath())).toMatchObject({ code: 'INVALID_INPUT' });
    e.picked.path = root;
    expect(await e.service.addEnginePath()).toEqual({ added: true });
    expect(e.service.enginePaths()).toEqual([root]);
    expect(e.service.removeEnginePath(0)).toEqual({ removed: true });
    expect(e.service.enginePaths()).toEqual([]);
    expect(() => e.service.removeEnginePath(3)).toThrow();
    expect(snapshotTree(root)).toEqual(before);
  });
});
