import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openMigratedDb } from '../../../../test/helpers/db';
import { memoryLogger } from '../../../../test/helpers/logger';
import { makeTempDir, removeTempDirs } from '../../../../test/helpers/temp';
import { createActivityLog, createRedactor } from '../../logging';
import { createProcessRunner } from '../../process';
import { createProjectRegistry } from '../../projects';
import { createPermissionService } from '../../security';
import { createAssetService } from './assets';
import { BLENDER_EXE } from './installs';
import { createBlenderService } from './service';

// A real headless Blender on this PC, if there is one (spec §16, Step 19 acceptance). It looks in GDCC_BLENDER_DIR (a folder that
// contains blender.exe), then in the usual install folders. With no Blender the whole suite is skipped, and the skip is reported.
// Everything happens in temporary folders; no real project or .blend file is read or written.

const candidates = [process.env['GDCC_BLENDER_DIR'] ?? '', ...(() => {
  const root = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Blender Foundation');
  try {
    return readdirSync(root).map((name) => join(root, name));
  } catch {
    return [];
  }
})()].filter((dir) => dir !== '' && existsSync(join(dir, BLENDER_EXE)));
const blenderDir = candidates[0];

afterEach(removeTempDirs);
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

describe.skipIf(blenderDir === undefined)('a real headless Blender', () => {
  async function env() {
    const { db } = await openMigratedDb();
    const logger = memoryLogger();
    const redactor = createRedactor();
    const activity = createActivityLog({ db, redactor, logger });
    const projects = createProjectRegistry({ db, activity, logger });
    const permissions = createPermissionService({ db, projects, activity, confirm: () => Promise.resolve(true) });
    const runner = createProcessRunner({ logger, redactor });
    const root = makeTempDir();
    mkdirSync(join(root, 'art'));
    // The test scene is made by Blender itself, in the temp project: the default scene (a cube, a light and a camera).
    const blend = join(root, 'art', 'scene.blend');
    const made = await runner.start({ executable: join(blenderDir as string, BLENDER_EXE), args: ['-b', '--factory-startup', '-noaudio', '--python-expr', `import bpy; bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blend)})`], cwd: root, timeoutMs: 120_000, maxOutputBytes: 1_000_000, purpose: 'Make a test scene', owner: { kind: 'engine', id: 'make-scene' } }).result;
    expect(made.exitCode).toBe(0);
    const project = projects.add(root);
    const assets = createAssetService({ db, projects, activity });
    const workRoot = join(makeTempDir(), 'blender-work');
    const service = createBlenderService({
      db, projects, runner, activity, permissions, assets, confirm: () => Promise.resolve(true), logger, redactor,
      openPath: () => Promise.resolve(''),
      pickFolder: () => Promise.resolve(blenderDir),
      env: () => ({}),
      workRoot,
    });
    await service.addPath();
    return { root, blend, project, service, workRoot, assets };
  }

  it('finds the install and reads its version', async () => {
    const e = await env();
    const view = await e.service.view(e.project.id);
    expect(view.installs[0]).toMatchObject({ folder: blenderDir, source: 'configured' });
    expect(view.installs[0]?.version).toMatch(/^\d+\.\d+/);
    // Blender 5.x saves compressed (zstd) by default; the version is read from the decompressed start of the file.
    expect(view.files[0]).toMatchObject({ path: 'art/scene.blend', version: view.installs[0]?.version?.split('.').slice(0, 2).join('.') });
    expect(view.files[0]?.newerThanInstalled).toBe(false);
  }, 120_000);

  it('describes the scene on a copy and leaves the original byte for byte alone', async () => {
    const e = await env();
    const before = sha(e.blend);
    const mtime = statSync(e.blend).mtimeMs;
    const run = await e.service.inspect(e.project.id, 'art/scene.blend');
    expect(run.errorSummary).toBe('');
    expect(run).toMatchObject({ outcome: 'passed', exitCode: 0, originalUnchanged: true });
    expect(run.result).toMatchObject({ objects: 3, meshes: 1, triangles: 12, unitSystem: 'METRIC' });
    expect(sha(e.blend)).toBe(before);
    expect(statSync(e.blend).mtimeMs).toBe(mtime);
    expect(readdirSync(join(e.root, 'art'))).toEqual(['scene.blend']); // no .blend1, nothing beside it
    expect(readdirSync(join(e.workRoot, run.id))).toContain('out');
  }, 180_000);

  it('runs an approved script that SAVES over the file it was given: the copy changes, the original does not, and an output is recorded', async () => {
    const e = await env();
    writeFileSync(
      join(e.root, 'art', 'export_and_save.py'),
      ['import bpy, sys, os', 'out = sys.argv[sys.argv.index("--out") + 1]', 'bpy.data.objects["Cube"].name = "Renamed"', 'bpy.ops.wm.save_mainfile()', 'open(os.path.join(out, "report.txt"), "w").write(bpy.data.filepath)', ''].join('\n'),
    );
    await e.service.approveScript(e.project.id, 'art/export_and_save.py');
    const before = sha(e.blend);
    const run = await e.service.runScript(e.project.id, 'art/export_and_save.py', 'art/scene.blend');
    expect(run).toMatchObject({ outcome: 'passed', exitCode: 0, originalUnchanged: true });
    expect(sha(e.blend)).toBe(before);
    expect(run.outputs.map((o) => o.path)).toEqual(expect.arrayContaining(['out/report.txt', 'scene.blend (modified copy)']));
    const reported = readFileSync(join(e.workRoot, run.id, 'out', 'report.txt'), 'utf8');
    expect(reported.startsWith(e.workRoot)).toBe(true); // the script saw the copy's path, not the project's
    expect(reported).not.toContain(e.root);
    expect(sha(join(e.workRoot, run.id, 'scene.blend'))).not.toBe(before);
    expect(readdirSync(join(e.root, 'art')).sort()).toEqual(['export_and_save.py', 'scene.blend']);
  }, 180_000);

  it('records a failing script: exit code, the Python error and an outcome of failed', async () => {
    const e = await env();
    writeFileSync(join(e.root, 'art', 'broken.py'), 'import bpy\nbpy.data.objects["Nope"].location.x = 1\n');
    await e.service.approveScript(e.project.id, 'art/broken.py');
    const run = await e.service.runScript(e.project.id, 'art/broken.py', 'art/scene.blend');
    expect(run).toMatchObject({ outcome: 'failed', exitCode: 1 });
    expect(run.errorSummary).toContain('KeyError');
    expect(run.originalUnchanged).toBe(true);
  }, 180_000);
});
