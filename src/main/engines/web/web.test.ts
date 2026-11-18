import { createConnection } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import { classifyScript, isLongRunning } from '@shared/web';
import { createFakeRunner } from '../../../../test/helpers/fake-runner';
import { openMigratedDb } from '../../../../test/helpers/db';
import { memoryLogger } from '../../../../test/helpers/logger';
import { closeOnCleanup, makeTempDir, removeTempDirs } from '../../../../test/helpers/temp';
import { copyFixture, snapshotTree } from '../../../../test/helpers/tree';
import { createActivityLog, createRedactor } from '../../logging';
import { createProcessRunner, type ProcessRunner } from '../../process';
import { locateProgram } from '../../providers';
import { createProjectRegistry } from '../../projects';
import { createCommandService, createPermissionService } from '../../security';
import { installCommand, webCapabilities } from './commands';
import { describeWebProject, detectPackageManager } from './project';
import { createServerRegistry, detectPort } from './servers';
import { createWebService, packageManagerOf, webCommandsFor } from './service';

afterEach(removeTempDirs);

describe('what a script is for', () => {
  it.each([
    ['dev', 'vite', 'dev'],
    ['start', 'vite --host', 'dev'],
    ['serve', 'node server.js', 'dev'],
    ['develop', 'vite dev --port 3000', 'dev'],
    ['preview', 'vite preview --port 4173', 'preview'],
    ['build', 'tsc && vite build', 'build'],
    ['bundle', 'vite build --mode production', 'build'],
    ['lint', 'eslint src', 'lint'],
    ['format', 'prettier --write .', 'lint'],
    ['typecheck', 'tsc --noEmit', 'typecheck'],
    ['check', 'svelte-check', 'typecheck'],
    ['test', 'vitest run', 'test'],
    ['e2e', 'playwright test', 'test'],
    ['test:unit', 'vitest', 'test'],
    ['clean', 'rimraf dist', 'other'],
    ['seed', 'node scripts/seed.js', 'other'],
    ['vitest-only', 'vitest', 'test'], // vitest is not vite
    ['optimize', 'vite optimize', 'other'],
  ] as const)('%s (%s) is %s', (name, body, kind) => {
    expect(classifyScript(name, body)).toBe(kind);
  });

  it('treats only dev and preview scripts as servers that keep running', () => {
    expect(['dev', 'preview'].every((k) => isLongRunning(k as 'dev' | 'preview'))).toBe(true);
    expect(['build', 'lint', 'typecheck', 'test', 'other'].some((k) => isLongRunning(k as 'build'))).toBe(false);
  });
});

describe('reading a web project', () => {
  it('reads package.json, the lockfile, the Vite config and the dependencies without changing anything', () => {
    const root = copyFixture('vite-game');
    const before = snapshotTree(root);
    const p = describeWebProject(root);
    expect(p).toMatchObject({ name: 'vite-game', version: '0.2.0', private: true, moduleType: 'module', viteConfig: 'vite.config.ts', nodeEngine: '>=20', nodeModules: false, dependencyCount: 5, frameworks: ['Phaser'] });
    expect(p?.packageManager).toEqual({ name: 'npm', source: 'lockfile', lockfile: 'package-lock.json', version: null, ambiguous: false });
    expect(p?.vite).toEqual({ range: '^5.4.0', installed: null });
    expect(p?.dependencies.map((d) => [d.name, d.dev, d.installed])).toEqual([['eslint', true, null], ['phaser', false, null], ['typescript', true, null], ['vite', true, null], ['vitest', true, null]]);
    expect(p?.notes.join(' ')).toContain('not installed');
    expect(snapshotTree(root)).toEqual(before);
  });

  it('reads installed versions from node_modules only for names npm allows', () => {
    const root = makeTempDir();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { vite: '^5', '..': '1', '../x': '1', phaser: '3' } }));
    mkdirSync(join(root, 'node_modules', 'vite'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'vite', 'package.json'), JSON.stringify({ version: '5.4.11' }));
    writeFileSync(join(root, 'package.json.bak'), 'x');
    const p = describeWebProject(root);
    expect(p?.vite).toEqual({ range: '^5', installed: '5.4.11' });
    expect(p?.dependencies.find((d) => d.name === '..')?.installed).toBeNull();
    expect(p?.dependencies.find((d) => d.name === 'phaser')?.installed).toBeNull();
    expect(p?.nodeModules).toBe(true);
  });

  it('returns nothing for a folder without a readable package.json', () => {
    expect(describeWebProject(makeTempDir())).toBeUndefined();
    const root = makeTempDir();
    writeFileSync(join(root, 'package.json'), '[1]');
    expect(describeWebProject(root)).toBeUndefined();
    writeFileSync(join(root, 'package.json'), '{ not json');
    expect(describeWebProject(root)).toBeUndefined();
  });

  it('chooses the package manager from the packageManager field, then the lockfile, and says when two lockfiles disagree', () => {
    const dir = (files: string[]): string => {
      const root = makeTempDir();
      for (const f of files) writeFileSync(join(root, f), '');
      return root;
    };
    expect(detectPackageManager(dir([]), {})).toEqual({ name: 'npm', source: 'default', lockfile: null, version: null, ambiguous: false });
    expect(detectPackageManager(dir(['pnpm-lock.yaml']), {})).toMatchObject({ name: 'pnpm', source: 'lockfile', lockfile: 'pnpm-lock.yaml' });
    expect(detectPackageManager(dir(['yarn.lock']), {})).toMatchObject({ name: 'yarn' });
    expect(detectPackageManager(dir(['bun.lockb']), {})).toMatchObject({ name: 'bun', lockfile: 'bun.lockb' });
    expect(detectPackageManager(dir(['package-lock.json', 'npm-shrinkwrap.json']), {})).toMatchObject({ name: 'npm', ambiguous: false });
    expect(detectPackageManager(dir(['pnpm-lock.yaml', 'package-lock.json']), {})).toMatchObject({ ambiguous: true });
    expect(detectPackageManager(dir(['pnpm-lock.yaml', 'package-lock.json']), { packageManager: 'npm@10.9.9+sha512.abc' })).toEqual({ name: 'npm', source: 'packageManager-field', lockfile: 'package-lock.json', version: '10.9.9', ambiguous: false });
    expect(detectPackageManager(dir([]), { packageManager: 'evil@1.0.0' })).toMatchObject({ name: 'npm', source: 'default' });
  });
});

describe('the install command', () => {
  const facts = (files: Record<string, string>, pkg: Record<string, unknown> = { name: 'x', dependencies: { a: '1' } }) => {
    const root = makeTempDir();
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
    for (const [f, text] of Object.entries(files)) writeFileSync(join(root, f), text);
    const described = describeWebProject(root);
    if (described === undefined) throw new Error('fixture');
    return { described, root };
  };
  const argvOf = (files: Record<string, string>, pkg?: Record<string, unknown>): string[] | string => {
    const { described, root } = facts(files, pkg);
    const result = installCommand(described, root);
    return 'command' in result ? result.command.argv : result.reason;
  };

  it('uses only the form that keeps the lockfile: ci or frozen or immutable, never install or add', () => {
    expect(argvOf({ 'package-lock.json': '{}' })).toEqual(['npm', 'ci']);
    expect(argvOf({ 'pnpm-lock.yaml': '' })).toEqual(['pnpm', 'install', '--frozen-lockfile']);
    expect(argvOf({ 'yarn.lock': '# yarn lockfile v1\n' })).toEqual(['yarn', 'install', '--frozen-lockfile']);
    expect(argvOf({ 'yarn.lock': '__metadata:\n  version: 8\n' })).toEqual(['yarn', 'install', '--immutable']);
    expect(argvOf({ 'yarn.lock': '' }, { packageManager: 'yarn@4.1.0' })).toEqual(['yarn', 'install', '--immutable']);
    expect(argvOf({ 'bun.lockb': '' })).toEqual(['bun', 'install', '--frozen-lockfile']);
  });

  it('offers nothing, with the reason, when there is no lockfile or two managers could be meant', () => {
    expect(argvOf({})).toContain('no lockfile');
    expect(argvOf({ 'pnpm-lock.yaml': '', 'package-lock.json': '{}' })).toContain('More than one');
  });

  it('says in its text that npm ci deletes node_modules, that install scripts run, and that the lockfile is not changed', () => {
    const { described, root } = facts({ 'package-lock.json': '{}' });
    const result = installCommand(described, root);
    if (!('command' in result)) throw new Error('expected a command');
    expect(result.command).toMatchObject({ label: 'npm: install exactly what package-lock.json says', writes: true });
    expect(result.command.body).toContain('deletes the node_modules folder');
    expect(result.command.body).toContain('install scripts');
    expect(result.command.body).toContain('does not change package.json or the lockfile');
  });

  it('is part of the commands the command service lists, and the package manager names the scripts', () => {
    const root = copyFixture('vite-game');
    expect(webCommandsFor(root).map((c) => c.argv)).toEqual([['npm', 'ci']]);
    expect(webCommandsFor(makeTempDir())).toEqual([]);
    expect(packageManagerOf(root)).toBe('npm');
    expect(packageManagerOf(makeTempDir())).toBe('npm');
  });
});

describe('the capability report', () => {
  it('says what is and is not offered', () => {
    const root = copyFixture('vite-game');
    const project = describeWebProject(root);
    if (project === undefined) throw new Error('fixture');
    const scripts = [{ kind: 'dev' as const, longRunning: true }, { kind: 'build' as const, longRunning: false }];
    const caps = Object.fromEntries(webCapabilities({ project, scripts, install: installCommand(project, root) }).map((c) => [c.id, c.state]));
    expect(caps).toEqual({ detect: 'implemented', 'package-manager': 'implemented', scripts: 'implemented', server: 'implemented', ports: 'implemented', stop: 'implemented', install: 'implemented', dependencies: 'unavailable' });
    const none = Object.fromEntries(webCapabilities({ project: undefined, scripts: [], install: undefined }).map((c) => [c.id, c.state]));
    expect(none).toMatchObject({ detect: 'unavailable', scripts: 'unavailable', server: 'unavailable', install: 'unavailable' });
  });
});

describe('the port a server prints', () => {
  it.each([
    ['  VITE v5.4.0  ready in 300 ms\n\n  \u001b[32m➜\u001b[39m  Local:   http://localhost:5173/', 5173],
    ['Local: http://127.0.0.1:4000', 4000],
    ['listening on http://[::1]:3000', 3000],
  ])('finds it in %j', (text, port) => {
    expect(detectPort(text)).toBe(port);
  });

  it('ignores network addresses, other hosts and nonsense', () => {
    expect(detectPort('Network: http://192.168.1.5:5173/')).toBeNull();
    expect(detectPort('see https://example.com:8080/')).toBeNull();
    expect(detectPort('http://localhost:99999/')).toBeNull();
    expect(detectPort('')).toBeNull();
  });
});

function registry(script: Parameters<typeof createFakeRunner>[0]) {
  const redactor = createRedactor();
  const runner = createFakeRunner(script);
  return { runner, redactor, servers: createServerRegistry({ runner, activity: { record: () => undefined } as never, redactor, newId: (() => { let n = 0; return () => `s${++n}`; })() }) };
}
const input = (label = 'npm run dev') => ({ projectId: 'p1', projectName: 'Game', label, program: 'C:\\n\\npm.cmd', args: ['run', 'dev'], cwd: 'C:\\g' });
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('the server registry', () => {
  it('starts a server as an owned process, reads its port from its own output, and shows a redacted tail', async () => {
    const r = registry(() => ({ hold: true, chunks: ['  \u001b[32m➜\u001b[0m  Local:   http://localhost:5173/\n', 'token=sk-ant-api03-notreal0123456789\n'] }));
    const { id } = r.servers.start(input());
    expect(r.runner.started[0]).toMatchObject({ executable: 'C:\\n\\npm.cmd', args: ['run', 'dev'], owner: { kind: 'engine', id: 'web-server-s1' }, projectId: 'p1' });
    expect(r.runner.started[0]?.timeoutMs).toBe(24 * 60 * 60 * 1000);
    await settle();
    const [server] = r.servers.list('p1');
    expect(server).toMatchObject({ id, status: 'running', port: 5173, url: 'http://localhost:5173/', exitCode: null });
    expect(server?.output).toContain('Local:   http://localhost:5173/');
    expect(server?.output).not.toContain('\u001b');
    expect(server?.output).not.toContain('sk-ant-api03-notreal');
    expect(r.servers.runningPort(id)).toBe(5173);
    expect(r.servers.running()).toBe(1);
    expect(r.servers.list('other')).toEqual([]);
  });

  it('refuses a second copy of the same script, and stops a server on request', async () => {
    const r = registry(() => ({ hold: true }));
    const { id } = r.servers.start(input());
    expect(() => r.servers.start(input())).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    r.servers.start(input('npm run preview')); // another script is fine
    expect(await r.servers.stop(id)).toEqual({ stopped: true });
    expect(r.runner.cancelled).toEqual(['You stopped the server']);
    await settle();
    expect(r.servers.list('p1').find((s) => s.id === id)).toMatchObject({ status: 'stopped', url: null });
    expect(await r.servers.stop(id)).toEqual({ stopped: false });
    expect(await r.servers.stop('nope')).toEqual({ stopped: false });
    expect(r.servers.runningPort(id)).toBeNull();
    r.servers.start(input()); // after it stopped, the same script can start again
  });

  it('records a server that ends on its own as failed, with its exit code and the end of its output', async () => {
    const r = registry(() => ({ exitCode: 1, stdout: 'Error: Port 5173 is already in use\n' }));
    r.servers.start(input());
    await settle();
    expect(r.servers.list('p1')[0]).toMatchObject({ status: 'failed', exitCode: 1, port: null });
    expect(r.servers.list('p1')[0]?.output).toContain('already in use');
    expect(r.servers.running()).toBe(0);
  });

  it('keeps only the last few ended servers of a project', async () => {
    const r = registry(() => ({ exitCode: 0 }));
    for (let i = 0; i < 8; i++) {
      r.servers.start(input(`npm run s${i}`));
      await settle();
    }
    expect(r.servers.list('p1')).toHaveLength(5);
  });
});

async function web(options: { fixture?: string; real?: boolean } = {}) {
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const redactor = createRedactor();
  const activity = createActivityLog({ db, redactor, logger });
  const projects = createProjectRegistry({ db, activity, logger });
  const project = projects.add(copyFixture(options.fixture ?? 'vite-game'));
  const answer = { yes: true };
  const asked: { title: string; detail?: string | undefined }[] = [];
  const confirm = (o: { title: string; message: string; detail?: string }): Promise<boolean> => (asked.push(o), Promise.resolve(answer.yes));
  const permissions = createPermissionService({ db, projects, activity, confirm });
  const runner: ProcessRunner = options.real === true ? createProcessRunner({ logger, redactor, graceMs: 300 }) : createFakeRunner((spec) => (spec.args.includes('dev') ? { hold: true, chunks: ['Local: http://localhost:5199/\n'] } : {}));
  if (options.real === true) closeOnCleanup(() => void runner.forceKillAll());
  const commands = createCommandService({ db, projects, permissions, activity, runner, redactor, confirm, locate: (name) => locateProgram([`${name}.cmd`, `${name}.exe`]), timeoutMs: () => 60_000, extra: (id) => webCommandsFor(projects.get(id)?.rootPath ?? ''), packageManager: packageManagerOf });
  const opened: string[] = [];
  const servers = createServerRegistry({ runner, activity, redactor });
  const service = createWebService({ projects, commands, servers, openExternal: (url) => (opened.push(url), Promise.resolve()) });
  return { db, project, commands, service, asked, answer, opened, runner, servers };
}
const failure = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a failure');
};

describe('the web service on the fixture project', () => {
  it('lists exactly the scripts of package.json with what each is for, and the lockfile install beside them', async () => {
    const e = await web();
    const view = e.service.view(e.project.id);
    expect(view.isWeb).toBe(true);
    expect(view.project?.scripts.map((s) => [s.label, s.kind, s.longRunning, s.approved])).toEqual([
      ['npm run dev', 'dev', true, false],
      ['npm run build', 'build', false, false],
      ['npm run preview', 'preview', true, false],
      ['npm run lint', 'lint', false, false],
      ['npm run typecheck', 'typecheck', false, false],
      ['npm run test', 'test', false, false],
      ['npm run clean', 'other', false, false],
      ['npm run seed', 'other', false, false],
    ]);
    expect(view.project?.scripts.find((s) => s.name === 'build')?.body).toBe('tsc && vite build\nnode scripts/size.js'); // the postbuild hook is part of build, not listed
    expect(view.extraCommands).toEqual([{ label: 'npm: install exactly what package-lock.json says', writes: true, approved: false }]);
    expect(view.servers).toEqual([]);
  });

  it('refuses a script that package.json does not list, a script that is not a server, and an unapproved one', async () => {
    const e = await web();
    expect((await failure(e.service.startServer(e.project.id, 'npm run nope'))).code).toBe('NOT_FOUND');
    expect((await failure(e.service.startServer(e.project.id, 'npm run build'))).code).toBe('INVALID_INPUT');
    expect((await failure(e.service.startServer(e.project.id, 'npm: install exactly what package-lock.json says'))).code).toBe('NOT_FOUND'); // only package scripts start as servers
    expect((await failure(e.service.startServer(e.project.id, 'npm run dev'))).code).toBe('PERMISSION_REQUIRED');
    expect((await failure(e.service.startServer('missing', 'npm run dev'))).code).toBe('NOT_FOUND');
    expect(e.runner.active()).toEqual([]);
    expect((e.runner as ReturnType<typeof createFakeRunner>).started).toEqual([]);
  });

  it('starts an approved server (not through Run), shows its port, opens only localhost, and stops it', async () => {
    const e = await web();
    await e.commands.approve(e.project.id, 'npm run dev');
    const approved = e.commands.discover(e.project.id).commands.find((c) => c.label === 'npm run dev');
    expect((await failure(e.commands.run(approved?.approval?.id ?? ''))).code).toBe('INVALID_INPUT'); // a server never runs to completion
    expect((await failure(e.commands.authorize(approved?.approval?.id ?? '', 'run'))).code).toBe('INVALID_INPUT');
    const started = await e.service.startServer(e.project.id, 'npm run dev');
    expect(started).toMatchObject({ started: true });
    await settle();
    const view = e.service.view(e.project.id);
    expect(view.servers[0]).toMatchObject({ label: 'npm run dev', status: 'running', port: 5199, url: 'http://localhost:5199/' });
    expect(view.project?.scripts[0]).toMatchObject({ approved: true });
    expect(await e.service.openServer(started.serverId ?? '')).toEqual({ opened: true });
    expect(e.opened).toEqual(['http://localhost:5199/']);
    expect((await failure(e.service.startServer(e.project.id, 'npm run dev'))).code).toBe('CONFLICT');
    expect(await e.service.stopServer(started.serverId ?? '')).toEqual({ stopped: true });
    await settle();
    expect(e.service.view(e.project.id).servers[0]?.status).toBe('stopped');
    expect((await failure(e.service.openServer(started.serverId ?? ''))).code).toBe('NOT_FOUND');
  });

  it('does not start a server whose script changed after it was approved', async () => {
    const e = await web();
    await e.commands.approve(e.project.id, 'npm run dev');
    const file = join(e.project.rootPath, 'package.json');
    writeFileSync(file, JSON.stringify({ name: 'vite-game', scripts: { dev: 'vite --host 0.0.0.0' } }));
    const error = await failure(e.service.startServer(e.project.id, 'npm run dev'));
    expect(error.code).toBe('PERMISSION_REQUIRED');
    expect(error.message).toContain('changed since you approved it');
  });

  it('names scripts after the package manager of the lockfile and finds its program', async () => {
    const e = await web();
    writeFileSync(join(e.project.rootPath, 'pnpm-lock.yaml'), '');
    rmSync(join(e.project.rootPath, 'package-lock.json'));
    const view = e.service.view(e.project.id);
    expect(view.project?.packageManager).toMatchObject({ name: 'pnpm' });
    expect(view.project?.scripts[0]?.label).toBe('pnpm run dev');
    expect(e.commands.discover(e.project.id).commands.find((c) => c.label === 'pnpm run dev')?.argv).toEqual(['pnpm', 'run', 'dev']);
    expect(view.extraCommands[0]?.label).toBe('pnpm: install exactly what pnpm-lock.yaml says');
  });

  it('reports a folder without a package.json as not a web project', async () => {
    const e = await web({ fixture: 'godot-project' });
    expect(e.service.view(e.project.id)).toMatchObject({ isWeb: false, project: null, servers: [], extraCommands: [] });
  });
});

const npmAvailable = locateProgram(['npm.cmd', 'npm.exe']) !== undefined;
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const portOpen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });

describe.skipIf(!npmAvailable)('a real dev server through npm (a stand-in for Vite that prints the same line)', () => {
  it('starts, prints its port, answers on it, stops with the whole process tree, and leaves nothing listening', async () => {
    const e = await web({ fixture: 'vite-runnable', real: true });
    await e.commands.approve(e.project.id, 'npm run dev');
    const { serverId } = await e.service.startServer(e.project.id, 'npm run dev');
    let port: number | null = null;
    for (let i = 0; i < 100 && port === null; i++) {
      await new Promise((r) => setTimeout(r, 100));
      port = e.service.view(e.project.id).servers[0]?.port ?? null;
    }
    expect(port).not.toBeNull();
    expect(await portOpen(port ?? 0)).toBe(true);
    const pids = e.runner.active().map((a) => a.pid ?? 0).filter((p) => p > 0);
    expect(pids.length).toBeGreaterThan(0);
    expect(e.runner.active()[0]?.owner).toMatchObject({ kind: 'engine' });
    expect(await e.service.stopServer(serverId ?? '')).toEqual({ stopped: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(e.runner.active()).toEqual([]);
    expect(pids.some(alive)).toBe(false);
    expect(await portOpen(port ?? 0)).toBe(false);
    expect(e.service.view(e.project.id).servers[0]).toMatchObject({ status: 'stopped', url: null });
  }, 60_000);

  it('runs an approved script to completion and refuses to start a script that is not a server', async () => {
    const e = await web({ fixture: 'vite-runnable', real: true });
    await e.commands.approve(e.project.id, 'npm run lint');
    const approval = e.commands.discover(e.project.id).commands.find((c) => c.label === 'npm run lint')?.approval;
    const result = await e.commands.run(approval?.id ?? '');
    expect(result).toMatchObject({ ran: true, status: 'exited', exitCode: 0 });
    expect(result.output).toContain('lint ok');
    expect((await failure(e.service.startServer(e.project.id, 'npm run lint'))).code).toBe('INVALID_INPUT');
    await e.commands.approve(e.project.id, 'npm run crash');
    const crash = await e.commands.run(e.commands.discover(e.project.id).commands.find((c) => c.label === 'npm run crash')?.approval?.id ?? '');
    expect(crash).toMatchObject({ status: 'exited', exitCode: 3 });
  }, 60_000);
});
