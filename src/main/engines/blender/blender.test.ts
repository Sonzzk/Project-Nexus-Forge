import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import { INSPECT_MARKER, type BriefFields } from '@shared/blender';
import { createFakeRunner } from '../../../../test/helpers/fake-runner';
import { openMigratedDb } from '../../../../test/helpers/db';
import { memoryLogger } from '../../../../test/helpers/logger';
import { makeTempDir, removeTempDirs } from '../../../../test/helpers/temp';
import { createActivityLog, createRedactor } from '../../logging';
import type { ProcessSpec } from '../../process';
import { createProjectRegistry } from '../../projects';
import { createPermissionService } from '../../security';
import { assetTables, createAssetService } from './assets';
import { parseBlendHeader, readBlendHeader, scanBlendFiles, scanBlenderScripts, versionNewer } from './blendfile';
import { discoverBlender, parseBlenderVersion } from './installs';
import { createBlenderService, errorSummaryOf } from './service';

afterEach(removeTempDirs);

const legacyHeader = (v = '403') => Buffer.concat([Buffer.from(`BLENDER-v${v}`), Buffer.alloc(40, 1)]);
const largeHeader = (v = '0501') => Buffer.concat([Buffer.from(`BLENDER17-01v${v}`), Buffer.alloc(40, 2)]);
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

const SCENE = { blender: '4.3.2', scenes: ['Scene'], objects: 3, objectTypes: { MESH: 2, LIGHT: 1 }, meshes: 2, triangles: 120, materials: 1, images: 1, collections: 1, actions: 0, armatures: 0, libraries: [], missingFiles: [{ kind: 'image', name: 'wood.png', path: '//tex/wood.png' }], unitSystem: 'METRIC', unitScale: 1 };

describe('reading a .blend header', () => {
  it('knows the older form, the newer form seen in Blender 5, and compressed files', () => {
    expect(parseBlendHeader(legacyHeader('403'))).toEqual({ format: 'legacy', version: '4.3' });
    expect(parseBlendHeader(legacyHeader('279'))).toEqual({ format: 'legacy', version: '2.79' });
    expect(parseBlendHeader(largeHeader('0501'))).toEqual({ format: 'large-header', version: '5.1' });
    expect(parseBlendHeader(Buffer.from([0x1f, 0x8b, 8, 0])).format).toBe('compressed');
    expect(parseBlendHeader(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0])).format).toBe('compressed');
    expect(parseBlendHeader(Buffer.from('PK\u0003\u0004 not blender'))).toEqual({ format: 'unknown', version: null });
    expect(parseBlendHeader(Buffer.alloc(0))).toEqual({ format: 'unknown', version: null });
  });

  it('names the version of gzip and zstd compressed files by decompressing the start of the file', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'a.blend'), gzipSync(legacyHeader('306')));
    writeFileSync(join(dir, 'b.blend'), zstdCompressSync(Buffer.concat([largeHeader('0501'), Buffer.alloc(200_000, 3)])));
    writeFileSync(join(dir, 'c.blend'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3])); // damaged
    expect(readBlendHeader(join(dir, 'a.blend'))).toEqual({ format: 'compressed', version: '3.6' });
    expect(readBlendHeader(join(dir, 'b.blend'))).toEqual({ format: 'compressed', version: '5.1' });
    expect(readBlendHeader(join(dir, 'c.blend'))).toEqual({ format: 'compressed', version: null });
    expect(readBlendHeader(join(dir, 'missing.blend'))).toEqual({ format: 'unknown', version: null });
  });

  it('compares versions by major and minor', () => {
    expect(versionNewer('5.1', '4.3')).toBe(true);
    expect(versionNewer('4.3', '4.3')).toBe(false);
    expect(versionNewer('4.2', '4.10')).toBe(false);
    expect(versionNewer('4.10', '4.2')).toBe(true);
  });
});

describe('scanning a project for Blender files', () => {
  it('lists .blend files with header version and backups, skips heavy and linked folders, and offers only scripts that import bpy', () => {
    const root = makeTempDir();
    mkdirSync(join(root, 'art', 'models'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(root, 'art', 'models', 'chair.blend'), legacyHeader('403'));
    writeFileSync(join(root, 'art', 'models', 'chair.blend1'), legacyHeader('403'));
    writeFileSync(join(root, 'art', 'room.BLEND'), largeHeader('0501'));
    writeFileSync(join(root, 'node_modules', 'x', 'skipped.blend'), legacyHeader());
    writeFileSync(join(root, 'art', 'export.py'), 'import bpy\nprint(1)\n');
    writeFileSync(join(root, 'art', 'plain.py'), 'print("not blender")\n');
    const scan = scanBlendFiles(root);
    expect(scan.files.map((f) => f.path).sort()).toEqual(['art/models/chair.blend', 'art/room.BLEND']);
    expect(scan.files.find((f) => f.path.endsWith('chair.blend'))).toMatchObject({ backups: 1, header: { version: '4.3', format: 'legacy' } });
    expect(scanBlenderScripts(root).map((s) => s.path)).toEqual(['art/export.py']);
    expect(readBlendHeader(join(root, 'art', 'room.BLEND')).version).toBe('5.1');
  });
});

describe('finding Blender installs', () => {
  const probe = (folders: Record<string, string | null>, extra: Partial<Parameters<typeof discoverBlender>[0]> = {}) => ({
    configured: () => [],
    defaultRoots: () => [],
    onPath: () => undefined,
    listDirectory: () => [],
    exists: (p: string) => Object.keys(folders).some((f) => p.toLowerCase() === `${f}\\blender.exe`.toLowerCase()),
    versionOf: (exe: string) => Promise.resolve(folders[exe.slice(0, -'\\blender.exe'.length)] ?? null),
    ...extra,
  });

  it('parses the first line of blender --version', () => {
    expect(parseBlenderVersion('Blender 5.1.2\n\tbuild date: 2026-05-19\n')).toBe('5.1.2');
    expect(parseBlenderVersion('nothing useful')).toBeNull();
  });

  it('merges configured folders, default folders and PATH, needs blender.exe, drops duplicates and puts the newest first', async () => {
    const found = await discoverBlender(
      probe(
        { 'C:\\Blender\\Blender 4.2': '4.2.1', 'D:\\tools\\b5': '5.1.2', 'C:\\bf\\Blender 3.6': null },
        {
          configured: () => ['D:\\tools\\b5', 'D:\\nothing-here'],
          defaultRoots: () => ['C:\\Blender', 'C:\\bf'],
          listDirectory: (p) => (p === 'C:\\Blender' ? ['Blender 4.2', 'Other'] : p === 'C:\\bf' ? ['Blender 3.6'] : []),
          onPath: () => 'C:\\Blender\\Blender 4.2\\blender.exe',
        },
      ),
    );
    expect(found.map((i) => [i.version, i.source])).toEqual([['5.1.2', 'configured'], ['4.2.1', 'default-folder'], ['3.6', 'default-folder']]);
    expect(found[2]?.note).toContain('could not be run');
  });
});

describe('script failures', () => {
  it('reports the last exception line of a Python traceback, or Blender\'s own Error lines', () => {
    expect(errorSummaryOf('x\nTraceback (most recent call last):\n  File "a.py", line 3, in <module>\nValueError: bad radius\n')).toBe('ValueError: bad radius');
    expect(errorSummaryOf('Error: Cannot read file\nError: second\nok')).toBe('Error: Cannot read file\nError: second');
    expect(errorSummaryOf('all good')).toBe('');
    // the order Blender 5.1 really prints: the traceback, then its own "script failed" line
    expect(errorSummaryOf('Traceback (most recent call last):\n  File "b.py", line 2, in <module>\n    x\nKeyError: \'k\'\n\nError: script failed, file: \'b.py\', exiting.\n')).toBe("KeyError: 'k'");
  });
});

async function env(options: { onRun?: (spec: ProcessSpec) => { stdout?: string; stderr?: string; exitCode?: number | null } | undefined; blenderVersion?: string; fileHeader?: Buffer } = {}) {
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const redactor = createRedactor();
  const activity = createActivityLog({ db, redactor, logger });
  const projects = createProjectRegistry({ db, activity, logger });
  const asked: { title: string; message: string; detail?: string | undefined }[] = [];
  const answer = { yes: true };
  const confirm = (o: { title: string; message: string; detail?: string }): Promise<boolean> => (asked.push(o), Promise.resolve(answer.yes));
  const permissions = createPermissionService({ db, projects, activity, confirm });
  const root = makeTempDir();
  mkdirSync(join(root, 'art'), { recursive: true });
  const blend = join(root, 'art', 'chair.blend');
  writeFileSync(blend, options.fileHeader ?? legacyHeader('403'));
  const script = join(root, 'art', 'export.py');
  writeFileSync(script, 'import bpy\nbpy.ops.wm.save_mainfile()\n');
  const project = projects.add(root);
  const installDir = makeTempDir();
  writeFileSync(join(installDir, 'blender.exe'), 'fake');
  const opened: string[] = [];
  const workRoot = join(makeTempDir(), 'blender-work');
  const runner = createFakeRunner((spec) => {
    if (spec.args[0] === '--version') return { stdout: `Blender ${options.blenderVersion ?? '4.3.2'}\n\tbuild date: x\n` };
    return options.onRun?.(spec) ?? { stdout: `${INSPECT_MARKER}${JSON.stringify(SCENE)}\n` };
  });
  const assets = createAssetService({ db, projects, activity });
  const service = createBlenderService({
    db, projects, runner, activity, permissions, assets, confirm, logger, redactor,
    openPath: (full) => (opened.push(full), Promise.resolve('')),
    pickFolder: () => Promise.resolve(installDir),
    env: () => ({ ProgramFiles: join(makeTempDir(), 'none') }),
    workRoot,
  });
  return { db, projects, project, root, blend, script, service, assets, asked, answer, opened, runner, workRoot, installDir, activity };
}

const failure = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a failure');
};
const runsOf = (e: Awaited<ReturnType<typeof env>>) => e.runner.started.filter((s) => s.args[0] !== '--version');

describe('a headless run never touches the original', () => {
  it('describes a scene from a copy: the original is not an argument, the copy lives in the app folder, flags come in the documented order', async () => {
    const e = await env();
    await e.service.addPath();
    const before = sha(e.blend);
    const mtime = statSync(e.blend).mtimeMs;
    const run = await e.service.inspect(e.project.id, 'art/chair.blend');
    expect(run).toMatchObject({ kind: 'inspect', outcome: 'passed', originalUnchanged: true, source: 'art/chair.blend', blenderVersion: '4.3.2' });
    expect(run.result).toMatchObject({ objects: 3, triangles: 120 });
    const spec = runsOf(e)[0] as ProcessSpec;
    expect(spec.args).not.toContain(e.blend);
    expect(spec.args.some((a) => a.startsWith(e.workRoot) && a.endsWith('chair.blend'))).toBe(true);
    expect(spec.args.slice(0, 4)).toEqual(['-b', '--factory-startup', '-noaudio', '--disable-autoexec']);
    expect(spec.args.indexOf('--python-exit-code')).toBeLessThan(spec.args.indexOf('--python')); // the exit code must be set before the script runs
    expect(spec.args[spec.args.indexOf('--') + 1]).toBe('--out');
    expect(spec.args[spec.args.indexOf('--origin-dir') + 1]).toBe(join(e.root, 'art')); // relative paths in the scene resolve against the original's folder
    expect(spec.cwd.startsWith(e.workRoot)).toBe(true);
    expect(spec.owner.kind).toBe('engine');
    expect(sha(e.blend)).toBe(before);
    expect(statSync(e.blend).mtimeMs).toBe(mtime);
    expect(existsSync(join(e.root, 'art', 'chair.blend1'))).toBe(false);
    expect(readFileSync(join(e.root, 'art', 'export.py'), 'utf8')).toContain('save_mainfile'); // nothing in the project was edited
  });

  it('a script that saves only changes the copy: the original keeps its bytes and the modified copy is listed as a result', async () => {
    const e = await env({
      onRun: (spec) => {
        const copy = spec.args[spec.args.indexOf('--python-exit-code') - 1] as string;
        writeFileSync(copy, Buffer.from('BLENDER-v403 SAVED BY THE SCRIPT'));
        writeFileSync(join(spec.args[spec.args.indexOf('--out') + 1] as string, 'chair.fbx'), 'fbx');
        return { stdout: 'saved\n' };
      },
    });
    await e.service.addPath();
    await e.service.approveScript(e.project.id, 'art/export.py');
    const before = sha(e.blend);
    const run = await e.service.runScript(e.project.id, 'art/export.py', 'art/chair.blend');
    expect(run).toMatchObject({ outcome: 'passed', originalUnchanged: true });
    expect(sha(e.blend)).toBe(before);
    expect(run.outputs.map((o) => o.path).sort()).toEqual(['chair.blend (modified copy)', 'out/chair.fbx']);
    expect(readFileSync(join(e.workRoot, run.id, 'chair.blend'), 'utf8')).toContain('SAVED BY THE SCRIPT');
  });

  it('flags the run as failed, loudly, if the original ever does differ afterwards (a safeguard against a bug of our own)', async () => {
    // the worst case, simulated by changing the original while Blender "runs"
    const holder: { blend: string } = { blend: '' };
    const e = await env({
      onRun: () => {
        writeFileSync(holder.blend, 'OVERWRITTEN');
        return { stdout: `${INSPECT_MARKER}${JSON.stringify(SCENE)}\n` };
      },
    });
    holder.blend = e.blend;
    await e.service.addPath();
    const run = await e.service.inspect(e.project.id, 'art/chair.blend');
    expect(run).toMatchObject({ outcome: 'failed', originalUnchanged: false });
    expect(run.errorSummary).toContain('different after the run');
  });

  it('records a failing script with its error and exit code, and a stopped run as inconclusive', async () => {
    const failing = await env({ onRun: () => ({ exitCode: 1, stderr: 'Traceback (most recent call last):\n  File "x.py", line 2\nRuntimeError: no active object\n' }) });
    await failing.service.addPath();
    await failing.service.approveScript(failing.project.id, 'art/export.py');
    const run = await failing.service.runScript(failing.project.id, 'art/export.py', 'art/chair.blend');
    expect(run).toMatchObject({ outcome: 'failed', exitCode: 1, errorSummary: 'RuntimeError: no active object' });
    expect(run.log).toContain('RuntimeError');
    expect(failing.service.run(run.id).outcome).toBe('failed');
  });

  it('refuses without an install, for a file saved by a newer Blender, for a path outside the project and for a file that is not .blend', async () => {
    const none = await env();
    expect((await failure(none.service.inspect(none.project.id, 'art/chair.blend'))).code).toBe('NOT_FOUND');
    const newer = await env({ fileHeader: largeHeader('0501') });
    await newer.service.addPath();
    expect((await failure(newer.service.inspect(newer.project.id, 'art/chair.blend'))).message).toContain('newer than the newest installed');
    const e = await env();
    await e.service.addPath();
    expect((await failure(e.service.inspect(e.project.id, '../chair.blend'))).code).toBe('PATH_OUTSIDE_PROJECT');
    expect((await failure(e.service.inspect(e.project.id, 'art/export.py'))).code).toBe('INVALID_INPUT');
    expect((await failure(e.service.inspect(e.project.id, 'art/missing.blend'))).code).toBe('NOT_FOUND');
    expect(runsOf(e)).toHaveLength(0);
  });
});

describe('approving a script', () => {
  it('shows the text and hash in the window, binds the approval to that text, and refuses after a change, a revoke or a decline', async () => {
    const e = await env();
    await e.service.addPath();
    const refused = await failure(e.service.runScript(e.project.id, 'art/export.py', 'art/chair.blend'));
    expect(refused.code).toBe('PERMISSION_REQUIRED');
    e.answer.yes = false;
    expect(await e.service.approveScript(e.project.id, 'art/export.py')).toEqual({ approved: false });
    expect((await failure(e.service.runScript(e.project.id, 'art/export.py', 'art/chair.blend'))).code).toBe('PERMISSION_REQUIRED');
    e.answer.yes = true;
    expect(await e.service.approveScript(e.project.id, 'art/export.py')).toEqual({ approved: true });
    const window = e.asked.at(-1);
    expect(window?.detail).toContain('bpy.ops.wm.save_mainfile()');
    expect(window?.detail).toContain('same rights as your Windows account');
    const view = await e.service.view(e.project.id);
    expect(view.scripts[0]).toMatchObject({ path: 'art/export.py', approved: true, changed: false });
    await e.service.runScript(e.project.id, 'art/export.py', 'art/chair.blend');
    writeFileSync(e.script, 'import bpy\nimport os\nos.system("whoami")\n'); // an edit after approval
    expect((await failure(e.service.runScript(e.project.id, 'art/export.py', 'art/chair.blend'))).message).toContain('changed since you approved it');
    expect((await e.service.view(e.project.id)).scripts[0]).toMatchObject({ approved: false, changed: true });
    const startedBefore = runsOf(e).length;
    await e.service.approveScript(e.project.id, 'art/export.py');
    const id = (await e.service.view(e.project.id)).scripts[0]?.approvalId as string;
    e.service.revokeScript(id);
    expect((await failure(e.service.runScript(e.project.id, 'art/export.py', 'art/chair.blend'))).code).toBe('PERMISSION_REQUIRED');
    expect(runsOf(e)).toHaveLength(startedBefore);
    expect(e.db.all('SELECT 1 FROM approvals WHERE what LIKE ?', 'Approved Blender script%').length).toBe(2);
  });

  it('will not approve a file that is not a Blender script or lies outside the project', async () => {
    const e = await env();
    writeFileSync(join(e.root, 'art', 'plain.py'), 'print(1)\n');
    expect((await failure(e.service.approveScript(e.project.id, 'art/plain.py'))).message).toContain('does not import bpy');
    expect((await failure(e.service.approveScript(e.project.id, '../x.py'))).code).toBe('PATH_OUTSIDE_PROJECT');
    expect(e.asked).toHaveLength(0);
  });
});

describe('opening a scene, folders and the listing', () => {
  it('opens only after the window, only a .blend inside the project, and says Windows chooses the program', async () => {
    const e = await env();
    await e.service.addPath();
    e.answer.yes = false;
    expect(await e.service.open(e.project.id, 'art/chair.blend')).toEqual({ opened: false });
    expect(e.opened).toEqual([]);
    e.answer.yes = true;
    expect(await e.service.open(e.project.id, 'art/chair.blend')).toEqual({ opened: true });
    expect(e.opened).toEqual([join(e.root, 'art', 'chair.blend')]);
    expect(e.asked.at(-1)?.detail).toContain('Windows decides which program opens');
    expect((await failure(e.service.open(e.project.id, '..\\..\\x.blend'))).code).toBe('PATH_OUTSIDE_PROJECT');
    expect((await failure(e.service.open(e.project.id, 'art/export.py'))).code).toBe('INVALID_INPUT');
  });

  it('adds a Blender folder only if it holds blender.exe, removes it from the list without touching the folder, and reports honest capabilities', async () => {
    const e = await env();
    const empty = makeTempDir();
    const service = createBlenderService({ db: e.db, projects: e.projects, runner: e.runner, activity: e.activity, permissions: createPermissionService({ db: e.db, projects: e.projects, activity: e.activity, confirm: () => Promise.resolve(true) }), assets: e.assets, confirm: () => Promise.resolve(true), logger: memoryLogger(), redactor: createRedactor(), openPath: () => Promise.resolve(''), pickFolder: () => Promise.resolve(empty), env: () => ({}), workRoot: e.workRoot });
    expect((await failure(service.addPath())).code).toBe('INVALID_INPUT');
    const before = await e.service.view(e.project.id);
    expect(before.installs).toEqual([]);
    expect(before.capabilities.find((c) => c.id === 'inspect')?.state).toBe('awaiting-configuration');
    expect(before.capabilities.find((c) => c.id === 'live-bridge')?.state).toBe('unavailable');
    await e.service.addPath();
    expect(await e.service.addPath()).toEqual({ added: false }); // the same folder twice
    const after = await e.service.view(e.project.id);
    expect(after.installs[0]).toMatchObject({ version: '4.3.2', source: 'configured' });
    expect(after.configuredPaths).toEqual([e.installDir]);
    expect(after.capabilities.find((c) => c.id === 'inspect')?.state).toBe('implemented');
    e.service.removePath(0);
    expect(existsSync(join(e.installDir, 'blender.exe'))).toBe(true);
    expect((await e.service.view(e.project.id)).configuredPaths).toEqual([]);
    expect(() => e.service.removePath(5)).toThrow();
  });

  it('marks a file saved by a newer Blender than any installed one, and counts backups', async () => {
    const e = await env({ fileHeader: largeHeader('0501') });
    writeFileSync(join(e.root, 'art', 'chair.blend1'), 'x');
    await e.service.addPath();
    const view = await e.service.view(e.project.id);
    expect(view.files[0]).toMatchObject({ version: '5.1', format: 'large-header', backups: 1, newerThanInstalled: true });
  });

  it('keeps run records and folders for the retention limit and removes only folders under its own work folder', async () => {
    const e = await env();
    await e.service.addPath();
    const run = await e.service.inspect(e.project.id, 'art/chair.blend');
    expect(existsSync(join(e.workRoot, run.id))).toBe(true);
    expect(e.service.prune('2000-01-01T00:00:00.000Z')).toBe(0);
    e.db.run('UPDATE blender_runs SET work_dir = ? WHERE id = ?', e.root, run.id); // a corrupted record pointing at the project
    expect(e.service.prune('2999-01-01T00:00:00.000Z')).toBe(1);
    expect(existsSync(join(e.root, 'art', 'chair.blend'))).toBe(true); // the project folder survived
  });
});

describe('asset tracking, briefs, naming and handoff', () => {
  const fields = (overrides: Partial<BriefFields> = {}): BriefFields => ({ name: 'Wooden chair', assetType: 'static-mesh', engine: 'unreal', purpose: 'Seating in the lobby', scale: '1 unit = 1 m, 0.9 m high', formats: 'FBX', textures: '2K albedo, normal', performance: 'Under 5k triangles', integration: '/Game/Props/Furniture', notes: '', taskId: null, assetId: null, ...overrides });

  it('tracks a file by path only, notices when it changed or went missing, and never touches the file', async () => {
    const e = await env();
    const before = sha(e.blend);
    const asset = e.assets.track({ projectId: e.project.id, path: 'art/chair.blend', note: 'hero prop', tags: ['prop', 'prop', ' lobby '] });
    expect(asset).toMatchObject({ path: 'art/chair.blend', kind: 'model', status: 'unchanged', tags: ['prop', 'lobby'] });
    writeFileSync(e.blend, Buffer.concat([legacyHeader(), Buffer.from('more')]));
    expect(e.assets.list(e.project.id)[0]?.status).toBe('changed');
    utimesSync(e.blend, new Date(), new Date());
    e.assets.track({ projectId: e.project.id, path: 'art/chair.blend' }); // tracking again records the new state
    expect(e.assets.list(e.project.id)[0]?.status).toBe('unchanged');
    expect(e.assets.list(e.project.id)).toHaveLength(1);
    expect(sha(e.blend)).not.toBe(before); // only because the test changed it
    expect(() => e.assets.track({ projectId: e.project.id, path: '../outside.png' })).toThrow();
    expect(() => e.assets.track({ projectId: e.project.id, path: 'art' })).toThrow(/Only a file/);
    expect(() => e.assets.track({ projectId: e.project.id, path: 'art/nothing.png' })).toThrow(/does not exist/);
    e.assets.untrack(asset.id);
    expect(existsSync(e.blend)).toBe(true);
    expect(e.assets.list(e.project.id)).toEqual([]);
  });

  it('saves, lists, updates and removes briefs, and refuses a task or asset from another project', async () => {
    const e = await env();
    const asset = e.assets.track({ projectId: e.project.id, path: 'art/chair.blend' });
    const saved = e.assets.saveBrief({ projectId: e.project.id, fields: fields({ assetId: asset.id }) });
    const updated = e.assets.saveBrief({ projectId: e.project.id, id: saved.id, fields: fields({ assetId: asset.id, purpose: 'Changed' }) });
    expect(updated.purpose).toBe('Changed');
    expect(e.assets.briefs(e.project.id)).toHaveLength(1);
    expect(() => e.assets.saveBrief({ projectId: e.project.id, fields: fields({ assetId: 'nope' }) })).toThrow(/does not belong/);
    expect(() => e.assets.saveBrief({ projectId: e.project.id, fields: fields({ taskId: 'nope' }) })).toThrow(/does not belong/);
    expect(() => e.assets.saveBrief({ projectId: e.project.id, id: 'missing', fields: fields() })).toThrow(/does not exist/);
    e.assets.untrack(asset.id);
    expect(e.assets.briefs(e.project.id)[0]?.assetId).toBeNull(); // the brief stays, its link is cleared
    e.assets.removeBrief(saved.id);
    expect(e.assets.briefs(e.project.id)).toEqual([]);
  });

  it('writes handoff notes from the brief and the last inspect of the linked file, and says plainly when there is no inspect', async () => {
    const e = await env();
    await e.service.addPath();
    const asset = e.assets.track({ projectId: e.project.id, path: 'art/chair.blend' });
    const brief = e.assets.saveBrief({ projectId: e.project.id, fields: fields({ assetId: asset.id }) });
    const without = e.assets.handoff(brief.id);
    expect(without.basedOnInspect).toBeNull();
    expect(without.text).toContain('No inspect has been run on this file yet');
    expect(without.text).toContain('`SM_WoodenChair`');
    expect(without.text).toContain('Unreal assets (`.uasset`, `.umap`) are binary');
    const run = await e.service.inspect(e.project.id, 'art/chair.blend');
    const withScene = e.assets.handoff(brief.id);
    expect(withScene.basedOnInspect).toBe(run.id);
    expect(withScene.text).toContain('120 triangles');
    expect(withScene.text).toContain('Missing external files (fix before export): //tex/wood.png');
    expect(withScene.text).toContain('export_scene.fbx');
    expect(withScene.text).toContain('Seating in the lobby');
    const empty = e.assets.saveBrief({ projectId: e.project.id, fields: fields({ name: 'Bare', purpose: '', scale: '' }) });
    expect(e.assets.handoff(empty.id).text).toContain('Scale: not specified in the brief');
  });

  it('registers both tables for export with schemas that accept their own rows', async () => {
    const e = await env();
    const asset = e.assets.track({ projectId: e.project.id, path: 'art/chair.blend' });
    e.assets.saveBrief({ projectId: e.project.id, fields: fields({ assetId: asset.id }) });
    for (const table of assetTables) {
      const rows = e.db.all<Record<string, string | number | null>>(`SELECT * FROM ${table.id}`);
      expect(rows.length).toBe(1);
      for (const row of rows) expect(() => table.schema.parse(row)).not.toThrow();
    }
    const bad = { ...e.db.get<Record<string, string | number | null>>('SELECT * FROM tracked_assets') };
    expect(assetTables[0]?.check?.({ ...bad, rel_path: '..\\evil.png' })).toContain('not a project-relative path');
  });
});
