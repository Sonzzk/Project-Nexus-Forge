import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import { PREVIEW_SCHEME, categoryOfPath, extensionOf, previewTypeOf, previewUrl } from '@shared/assets';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { copyFixture, snapshotTree } from '../../../test/helpers/tree';
import { assetTables, createAssetService } from '../engines/blender/assets';
import { createActivityLog, createRedactor } from '../logging';
import { createProjectRegistry } from '../projects';
import { createPermissionService } from '../security';
import { createTaskService } from '../planning';
import { createAssetIndex } from './asset-index';
import { createAssetOps } from './asset-ops';
import { resolvePreview } from './asset-preview';
import { buildAssetRegister } from './asset-register';
import { scanAssetFiles } from './asset-scan';

afterEach(removeTempDirs);

describe('what kind of content a path is', () => {
  it.each([
    ['art/chair.blend', 'model'],
    ['a/b/Rock.FBX', 'model'],
    ['tex/wood.png', 'texture'],
    ['tex/wood.PNG', 'texture'],
    ['m/rock.gdshader', 'material'],
    ['sfx/boom.wav', 'audio'],
    ['anim/run.anim', 'animation'],
    ['levels/main.tscn', 'scene'],
    ['src/player.gd', 'script'],
    ['ui/font.ttf', 'font'],
    ['video/intro.mp4', 'video'],
    ['Content/Hero.uasset', 'engine'],
    ['export/game.exe', 'build'],
    ['dist/game.zip', 'build'],
    ['pack/game.pck', 'build'],
    ['tools/helper.exe', null],
    ['notes/readme.md', null],
    ['noextension', null],
    ['.hidden', null],
  ] as const)('%s is %s', (path, category) => {
    expect(categoryOfPath(path)).toBe(category);
  });

  it('reads extensions from the last name only, and offers previews for safe image types', () => {
    expect(extensionOf('a.b/c')).toBe('');
    expect(extensionOf('a/b.TAR.gz')).toBe('gz');
    expect(previewTypeOf('x.PNG')).toBe('image/png');
    expect(previewTypeOf('x.svg')).toBeUndefined(); // SVG can carry script
    expect(previewTypeOf('x.uasset')).toBeUndefined();
    expect(previewUrl('p 1', 'a b/c#d.png')).toBe(`${PREVIEW_SCHEME}://preview/p%201?p=a%20b%2Fc%23d.png`);
  });
});

describe('scanning a project for assets', () => {
  it('lists game content with sizes and times, skips generated folders, links and credential-like names, and changes nothing', () => {
    const root = copyFixture('assets-project');
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'skipped.png'), 'x');
    mkdirSync(join(root, '.git', 'objects'), { recursive: true });
    writeFileSync(join(root, '.git', 'objects', 'skipped.png'), 'x');
    writeFileSync(join(root, '.env.png'), 'x');
    const before = snapshotTree(root);
    const out = scanAssetFiles(root, { maxEntries: 10_000, budgetMs: 5000 });
    const paths = out.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      'a/b/c/d/e/f/g/h/i/deep.png', 'art/Barrel.glb', 'art/My Rock.png', 'art/Wood-Plank.PNG', 'art/crate.fbx', 'art/props/crate.fbx', 'art/rock.png', 'audio/boom.wav', 'audio/music/theme.ogg', 'data/hero.uasset', 'export/game.exe', 'fonts/ui.ttf', 'loose.png', 'materials/rock.gdshader', 'scenes/main.tscn', 'scripts/player.gd', 'video/intro.mp4',
    ]);
    expect(out.files.find((f) => f.path === 'export/game.exe')).toMatchObject({ category: 'build', extension: 'exe', bytes: 2 });
    expect(out.truncated).toBe(false);
    expect(snapshotTree(root)).toEqual(before);
  });

  it('skips a link instead of following it', () => {
    const root = copyFixture('assets-project');
    const outside = makeTempDir();
    writeFileSync(join(outside, 'secret.png'), 'x');
    try {
      symlinkSync(outside, join(root, 'linked'), 'junction');
    } catch {
      return; // links need rights this machine does not give; the rest of the scan is covered above
    }
    expect(scanAssetFiles(root, { maxEntries: 10_000, budgetMs: 5000 }).files.some((f) => f.path.startsWith('linked/'))).toBe(false);
  });

  it('stops at its file limit or its time limit and says so', () => {
    const root = copyFixture('assets-project');
    expect(scanAssetFiles(root, { maxEntries: 5, budgetMs: 5000 })).toMatchObject({ truncated: true, entries: 6 });
    let t = 0;
    const slow = scanAssetFiles(root, { maxEntries: 10_000, budgetMs: 100, now: () => (t += 60) });
    expect(slow.truncated).toBe(true);
    expect(slow.files.length).toBeLessThan(17);
  });
});

async function env() {
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const redactor = createRedactor();
  const activity = createActivityLog({ db, redactor, logger });
  const projects = createProjectRegistry({ db, activity, logger });
  const root = copyFixture('assets-project');
  const project = projects.add(root);
  const asked: { title: string; message: string; detail?: string | undefined }[] = [];
  const answer = { yes: true };
  const confirm = (o: { title: string; message: string; detail?: string }): Promise<boolean> => (asked.push(o), Promise.resolve(answer.yes));
  const permissions = createPermissionService({ db, projects, activity, confirm });
  const assets = createAssetService({ db, projects, activity });
  const limits = { maxEntries: 10_000, budgetMs: 5000 };
  const index = createAssetIndex({ db, projects, activity, tracking: assets, limits: () => limits });
  const trashed: string[] = [];
  const ops = createAssetOps({ db, projects, permissions, activity, confirm, trashItem: (p) => (trashed.push(p), Promise.resolve()) });
  const tasks = createTaskService({ db, projects, activity, requirePlanApproval: () => false });
  const task = (title: string) => tasks.create({ projectId: project.id, title, description: '', provider: '', complexity: 'm', priority: 'normal' });
  return { db, projects, project, root, index, ops, assets, permissions, asked, answer, trashed, task, tasks, limits, activity };
}
const failure = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a failure');
};

describe('the asset index', () => {
  it('indexes a project, then rescans incrementally: only added, changed and removed files are written', async () => {
    const e = await env();
    const first = e.index.scan(e.project.id);
    expect(first).toMatchObject({ files: 17, added: 17, changed: 0, removed: 0, unchanged: 0, truncated: false });
    const second = e.index.scan(e.project.id);
    expect(second).toMatchObject({ added: 0, changed: 0, removed: 0, unchanged: 17 });
    writeFileSync(join(e.root, 'art', 'rock.png'), 'a different, longer file');
    writeFileSync(join(e.root, 'art', 'new_tree.png'), 'x');
    await new Promise((r) => setTimeout(r, 5));
    const { rmSync } = await import('node:fs');
    rmSync(join(e.root, 'audio', 'boom.wav'));
    const third = e.index.scan(e.project.id);
    expect(third).toMatchObject({ added: 1, changed: 1, removed: 1, unchanged: 15, files: 17 });
    const rock = e.index.search({ projectId: e.project.id, query: 'art/rock.png' }).items[0];
    expect(rock).toMatchObject({ path: 'art/rock.png', category: 'texture', bytes: 24, previewable: true, annotation: null });
    expect(e.index.search({ projectId: e.project.id, query: 'boom' }).total).toBe(0);
  });

  it('does not remove anything when a scan stopped at its limit, because it has not seen every file', async () => {
    const e = await env();
    e.index.scan(e.project.id);
    e.limits.maxEntries = 6;
    const partial = e.index.scan(e.project.id);
    expect(partial).toMatchObject({ truncated: true, removed: 0 });
    expect(e.index.search({ projectId: e.project.id }).total).toBe(17);
    expect(e.index.lastScan(e.project.id)?.truncated).toBe(true);
  });

  it('searches path, notes, tags, source and usage together, filters by category, tag and task, and pages', async () => {
    const e = await env();
    e.index.scan(e.project.id);
    const crate = e.task('Place crates');
    e.index.annotate({ projectId: e.project.id, relativePath: 'art/props/crate.fbx', note: 'Hero prop for the warehouse', tags: ['prop', 'Warehouse', 'prop', ' '], source: 'Made in-house by Sam', usage: 'Warehouse level', taskIds: [crate.id] });
    e.index.annotate({ projectId: e.project.id, relativePath: 'art/rock.png', note: '', tags: ['terrain'], source: '', usage: '', taskIds: [] });
    const id = e.project.id;
    expect(e.index.search({ projectId: id, query: 'warehouse' }).items.map((i) => i.path)).toEqual(['art/props/crate.fbx']);
    expect(e.index.search({ projectId: id, query: 'sam crate' }).items.map((i) => i.path)).toEqual(['art/props/crate.fbx']); // every word must match somewhere
    expect(e.index.search({ projectId: id, query: 'sam nothing' }).total).toBe(0);
    expect(e.index.search({ projectId: id, tag: 'prop' }).items.map((i) => i.path)).toEqual(['art/props/crate.fbx']);
    expect(e.index.search({ projectId: id, tag: 'pro' }).total).toBe(0); // whole tags only
    expect(e.index.search({ projectId: id, taskId: crate.id }).total).toBe(1);
    expect(e.index.search({ projectId: id, annotatedOnly: true }).total).toBe(2);
    const textures = e.index.search({ projectId: id, category: 'texture', limit: 2, offset: 1 });
    expect(textures.items).toHaveLength(2);
    expect(textures.total).toBe(5);
    expect(textures.counts).toMatchObject({ texture: 5, model: 3, audio: 2, font: 1, video: 1, build: 1, script: 1, scene: 1, material: 1, engine: 1, animation: 0 });
    expect(e.index.search({ projectId: id, query: '100%_' }).total).toBe(0); // LIKE characters are plain text
    const item = e.index.search({ projectId: id, query: 'crate.fbx', annotatedOnly: true }).items[0];
    expect(item?.annotation).toMatchObject({ note: 'Hero prop for the warehouse', tags: ['prop', 'Warehouse'], source: 'Made in-house by Sam', usage: 'Warehouse level', taskIds: [crate.id], status: 'unchanged' });
  });

  it('keeps tags, notes, sources and task links across a rescan, and reports a changed file', async () => {
    const e = await env();
    e.index.scan(e.project.id);
    const t = e.task('Texture pass');
    e.index.annotate({ projectId: e.project.id, relativePath: 'art/rock.png', note: 'n', tags: ['a'], source: 's', usage: 'u', taskIds: [t.id] });
    e.index.scan(e.project.id);
    writeFileSync(join(e.root, 'art', 'rock.png'), 'edited so the size differs');
    e.index.scan(e.project.id);
    const item = e.index.search({ projectId: e.project.id, query: 'art/rock.png' }).items[0];
    expect(item?.annotation).toMatchObject({ note: 'n', source: 's', taskIds: [t.id], status: 'changed' });
  });

  it('refuses a task from another project, a missing file and a folder, and keeps at most 20 tags', async () => {
    const e = await env();
    e.index.scan(e.project.id);
    const otherRoot = makeTempDir();
    const other = e.projects.add(otherRoot);
    const foreign = e.tasks.create({ projectId: other.id, title: 'Foreign', description: '', provider: '', complexity: 'm', priority: 'normal' });
    expect((await failure(Promise.resolve().then(() => e.index.annotate({ projectId: e.project.id, relativePath: 'art/rock.png', taskIds: [foreign.id] })))).code).toBe('INVALID_INPUT');
    expect((await failure(Promise.resolve().then(() => e.index.annotate({ projectId: e.project.id, relativePath: 'art/missing.png' })))).code).toBe('NOT_FOUND');
    expect((await failure(Promise.resolve().then(() => e.index.annotate({ projectId: e.project.id, relativePath: 'art' })))).code).toBe('INVALID_INPUT');
    expect((await failure(Promise.resolve().then(() => e.index.annotate({ projectId: e.project.id, relativePath: '../outside.png' })))).code).toBe('PATH_OUTSIDE_PROJECT');
    const many = Array.from({ length: 30 }, (_, i) => `tag${i}`);
    expect(e.index.annotate({ projectId: e.project.id, relativePath: 'art/rock.png', tags: many }).annotation?.tags).toHaveLength(20);
  });

  it('is removed with its project, and the notes leave with the tracked asset', async () => {
    const e = await env();
    e.index.scan(e.project.id);
    const item = e.index.annotate({ projectId: e.project.id, relativePath: 'art/rock.png', source: 's', taskIds: [e.task('t').id] });
    e.assets.untrack(item.annotation?.id ?? '');
    expect(e.db.all('SELECT * FROM asset_details')).toEqual([]);
    expect(e.db.all('SELECT * FROM asset_task_refs')).toEqual([]);
    e.projects.remove(e.project.id);
    expect(e.db.all('SELECT * FROM asset_index')).toEqual([]);
    expect(e.db.all('SELECT * FROM asset_scans')).toEqual([]);
  });
});

describe('naming and folder checks', () => {
  it('applies the Godot rule to the fixture and only reports', async () => {
    const e = await env();
    e.index.scan(e.project.id);
    const before = snapshotTree(e.root);
    const report = e.index.checks(e.project.id);
    expect(report.engine).toBe('godot');
    expect(report.checked).toBe(17);
    const by = (rule: string) => report.findings.filter((f) => f.rule === rule).map((f) => f.path);
    expect(by('spaces')).toEqual(['art/My Rock.png']);
    expect(by('characters')).toEqual(['art/Wood-Plank.PNG']);
    expect(by('case')).toEqual(['art/Barrel.glb']);
    expect(by('loose-root')).toEqual(['loose.png']);
    expect(by('depth')).toEqual(['a/b/c/d/e/f/g/h/i/deep.png']);
    expect(by('duplicate-name')).toHaveLength(1);
    expect(report.findings.find((f) => f.rule === 'spaces')?.suggestion).toBe('art/my_rock.png');
    expect(report.findings.find((f) => f.rule === 'case')?.suggestion).toBe('art/barrel.glb');
    expect(report.more).toBe(0);
    expect(report.note).toContain('nothing was renamed');
    expect(snapshotTree(e.root)).toEqual(before);
  });

  it('checks Unreal prefixes for source files only and says why .uasset is not checked', async () => {
    const e = await env();
    e.db.run("UPDATE projects SET type = 'unreal' WHERE id = ?", e.project.id);
    e.index.scan(e.project.id);
    const report = e.index.checks(e.project.id);
    expect(report.engine).toBe('unreal');
    expect(report.findings.filter((f) => f.rule === 'prefix').map((f) => f.path)).toContain('art/rock.png');
    expect(report.findings.find((f) => f.path === 'art/rock.png')?.suggestion).toBe('art/T_Rock.png');
    expect(report.findings.some((f) => f.path === 'data/hero.uasset' && f.rule === 'prefix')).toBe(false);
    expect(report.rule).toContain('.uasset');
  });

  it('says the index is empty before the first scan', async () => {
    const e = await env();
    expect(e.index.checks(e.project.id)).toMatchObject({ checked: 0, findings: [] });
    expect(e.index.checks(e.project.id).note).toContain('Scan the project first');
  });
});

describe('the asset register text', () => {
  it('lists annotated assets with source, usage, tasks and tags, escapes table characters, and summarizes the index', async () => {
    const e = await env();
    e.index.scan(e.project.id);
    const t = e.task('Dress | the hall');
    e.index.annotate({ projectId: e.project.id, relativePath: 'art/rock.png', note: 'line one\nline two | pipe', tags: ['terrain', 'stone'], source: 'CC0 pack, "Rocks"', usage: 'Cave level', taskIds: [t.id] });
    const text = buildAssetRegister(e.db, { id: e.project.id, name: e.project.name }, '2026-11-18');
    expect(text).toContain('# Asset register: assets-project');
    expect(text).toContain('Written 2026-11-18');
    expect(text).toContain('| `art/rock.png` | Textures and images | CC0 pack, "Rocks" | Cave level; tasks: Dress \\| the hall | terrain, stone | line one line two \\| pipe |');
    expect(text).toContain('| 3D models | 3 |');
    expect(text).toContain('| Exported builds | 1 |');
    expect(text).not.toContain('node_modules');
  });

  it('says plainly when nothing was annotated or scanned', async () => {
    const e = await env();
    const text = buildAssetRegister(e.db, { id: e.project.id, name: 'P' }, '2026-11-18');
    expect(text).toContain('No asset has been annotated yet');
    expect(text).toContain('has not been scanned yet');
  });
});

describe('previews', () => {
  const reg = async () => {
    const e = await env();
    return { e, url: (path: string, id = e.project.id) => previewUrl(id, path) };
  };

  it('serves an image inside a registered project and nothing else', async () => {
    const { e, url } = await reg();
    const ok = resolvePreview(url('art/rock.png'), e.projects);
    expect(ok).toMatchObject({ ok: true, mime: 'image/png', bytes: 70 });
    expect(ok.ok && ok.fullPath.toLowerCase()).toContain(join(e.root, 'art', 'rock.png').toLowerCase());
    expect(resolvePreview(url('art/Wood-Plank.PNG'), e.projects).ok).toBe(true); // extension case does not matter
  });

  it.each([
    ['../outside.png'],
    ['..\\outside.png'],
    ['art/../../outside.png'],
    ['%2e%2e/outside.png'],
    ['C:/Windows/win.png'],
    ['/etc/passwd.png'],
    ['\\\\server\\share\\x.png'],
    ['art/rock.png\0.exe'],
    [''],
  ])('refuses the path %j', async (path) => {
    const { e } = await reg();
    expect(resolvePreview(previewUrl(e.project.id, path), e.projects).ok).toBe(false);
  });

  it('refuses another project id, a made-up id, other schemes and hosts, other file types, folders and missing files', async () => {
    const { e, url } = await reg();
    expect(resolvePreview(url('art/rock.png', 'not-a-project'), e.projects).ok).toBe(false);
    expect(resolvePreview(url('art/rock.png', '../x'), e.projects).ok).toBe(false);
    expect(resolvePreview(`http://preview/${e.project.id}?p=art%2Frock.png`, e.projects).ok).toBe(false);
    expect(resolvePreview(`${PREVIEW_SCHEME}://other/${e.project.id}?p=art%2Frock.png`, e.projects).ok).toBe(false);
    expect(resolvePreview('not a url', e.projects).ok).toBe(false);
    expect(resolvePreview(`${PREVIEW_SCHEME}://preview/${e.project.id}`, e.projects).ok).toBe(false);
    writeFileSync(join(e.root, 'art', 'vector.svg'), '<svg onload="alert(1)"/>');
    for (const bad of ['art/vector.svg', 'scripts/player.gd', 'data/hero.uasset', 'project.godot', 'art', 'art/props', 'art/missing.png', 'art/secret_key.png']) expect(resolvePreview(url(bad), e.projects).ok, bad).toBe(false);
  });

  it('refuses a file over the size limit and a link that leaves the project', async () => {
    const { e, url } = await reg();
    writeFileSync(join(e.root, 'art', 'huge.png'), Buffer.alloc(9 * 1024 * 1024));
    expect(resolvePreview(url('art/huge.png'), e.projects)).toMatchObject({ ok: false, reason: 'too large to preview' });
    const outside = makeTempDir();
    writeFileSync(join(outside, 'private.png'), 'x');
    try {
      symlinkSync(outside, join(e.root, 'linked'), 'junction');
    } catch {
      return;
    }
    expect(resolvePreview(url('linked/private.png'), e.projects).ok).toBe(false);
  });
});

describe('moving, renaming and removing files', () => {
  const grant = async (e: Awaited<ReturnType<typeof env>>): Promise<void> => {
    await e.permissions.request({ projectId: e.project.id, scope: 'project-writes' });
    e.asked.length = 0;
  };

  it('previews a move without touching anything, and says what the app does not do', async () => {
    const e = await env();
    writeFileSync(join(e.root, 'art', 'rock.png.meta'), 'guid');
    const before = snapshotTree(e.root);
    const preview = e.ops.previewMove(e.project.id, [{ from: 'art/rock.png', to: 'art/stone/rock.png' }]);
    expect(preview).toMatchObject({ kind: 'move', problems: [], permitted: false, items: [{ from: 'art/rock.png', to: 'art/stone/rock.png', bytes: 70, tracked: false }] });
    expect(preview.warnings.join(' ')).toContain('not updated');
    expect(preview.warnings.join(' ')).toContain('.meta');
    expect(snapshotTree(e.root)).toEqual(before);
  });

  it.each([
    ['overwriting', { from: 'art/rock.png', to: 'art/My Rock.png' }, /already exists/],
    ['a changed extension', { from: 'art/rock.png', to: 'art/rock.jpg' }, /extension/],
    ['the same path', { from: 'art/rock.png', to: 'art/rock.png' }, /same/],
    ['a sensitive name', { from: 'art/rock.png', to: 'art/secret_rock.png' }, /credentials/],
    ['a sensitive source', { from: 'art/secret_key.png', to: 'art/key.png' }, /credentials/],
    ['a path outside', { from: 'art/rock.png', to: '../rock.png' }, /not inside/],
    ['an absolute path', { from: 'art/rock.png', to: 'C:/rock.png' }, /not inside/],
    ['a missing file', { from: 'art/nothing.png', to: 'art/x.png' }, /does not exist/],
    ['a folder', { from: 'art/props', to: 'art/props2' }, /not a regular file/],
    ['a source outside', { from: '../x.png', to: 'x.png' }, /not inside/],
  ])('refuses %s', async (_name, move, message) => {
    const e = await env();
    const preview = e.ops.previewMove(e.project.id, [move]);
    expect(preview.problems.join(' ')).toMatch(message);
    expect(preview.items).toEqual([]);
    expect((await failure(e.ops.move(e.project.id, [move]))).code).toBe('INVALID_INPUT');
    if (!existsSync(join(e.root, 'art', 'rock.png'))) throw new Error('the source file must still be there');
  });

  it('refuses two files with one destination and a destination that a stale tracked entry holds', async () => {
    const e = await env();
    expect(e.ops.previewMove(e.project.id, [{ from: 'art/rock.png', to: 'x/a.png' }, { from: 'art/My Rock.png', to: 'x/A.png' }]).problems.join(' ')).toContain('Two files would both become');
    e.index.scan(e.project.id);
    e.index.annotate({ projectId: e.project.id, relativePath: 'art/rock.png', note: 'n' });
    const { rmSync } = await import('node:fs');
    rmSync(join(e.root, 'art', 'rock.png'));
    expect(e.ops.previewMove(e.project.id, [{ from: 'art/My Rock.png', to: 'art/rock.png' }]).problems.join(' ')).toContain('tracked asset whose file is missing');
  });

  it('needs the project-writes permission first (asked in a window), then a confirmation that lists the files, and a decline changes nothing', async () => {
    const e = await env();
    const moves = [{ from: 'art/rock.png', to: 'art/stone/rock.png' }];
    e.answer.yes = false;
    expect(await e.ops.move(e.project.id, moves)).toEqual({ done: false, count: 0 });
    expect(e.asked).toHaveLength(1); // the permission window was refused, so there was no second window
    expect(e.permissions.has(e.project.id, null, 'project-writes')).toBe(false);
    expect(existsSync(join(e.root, 'art', 'rock.png'))).toBe(true);
    e.answer.yes = true;
    await grant(e);
    e.answer.yes = false;
    expect(await e.ops.move(e.project.id, moves)).toEqual({ done: false, count: 0 });
    expect(e.asked[0]?.detail).toContain('art/rock.png\n    -> art/stone/rock.png');
    expect(existsSync(join(e.root, 'art', 'rock.png'))).toBe(true);
    expect(existsSync(join(e.root, 'art', 'stone'))).toBe(false);
  });

  it('moves the files, creates the folders, and carries the index, the notes and the task links with the file', async () => {
    const e = await env();
    e.index.scan(e.project.id);
    const t = e.task('Rocks');
    e.index.annotate({ projectId: e.project.id, relativePath: 'art/rock.png', note: 'keep', source: 'me', taskIds: [t.id] });
    await grant(e);
    expect(await e.ops.move(e.project.id, [{ from: 'art/rock.png', to: 'art/stone/rock.png' }])).toEqual({ done: true, count: 1 });
    expect(existsSync(join(e.root, 'art', 'rock.png'))).toBe(false);
    expect(readFileSync(join(e.root, 'art', 'stone', 'rock.png')).length).toBe(70);
    const moved = e.index.search({ projectId: e.project.id, query: 'stone/rock' }).items[0];
    expect(moved?.annotation).toMatchObject({ note: 'keep', source: 'me', taskIds: [t.id], status: 'unchanged' });
    expect(e.index.search({ projectId: e.project.id, query: 'art/rock.png' }).total).toBe(0);
    expect(e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE scope = 'project-writes' AND what LIKE 'Moved%'")?.n).toBe(1);
  });

  it('puts every file back when a later step fails', async () => {
    const e = await env();
    await grant(e);
    writeFileSync(join(e.root, 'blocker'), 'a file where a folder is needed');
    const error = await failure(e.ops.move(e.project.id, [{ from: 'art/rock.png', to: 'art/stone/rock.png' }, { from: 'art/My Rock.png', to: 'blocker/My Rock.png' }]));
    expect(error.code).toBe('TOOL_FAILED');
    expect(error.message).toContain('put back');
    expect(existsSync(join(e.root, 'art', 'rock.png'))).toBe(true);
    expect(existsSync(join(e.root, 'art', 'My Rock.png'))).toBe(true);
    expect(existsSync(join(e.root, 'art', 'stone'))).toBe(false);
  });

  it('refuses while an agent holds the writer lock on the project', async () => {
    const e = await env();
    await grant(e);
    e.db.run("INSERT INTO writer_locks (project_id, run_id, acquired_at, working_dir) VALUES (?, 'run-1', '2026-01-01T00:00:00.000Z', ?)", e.project.id, e.root);
    expect((await failure(e.ops.move(e.project.id, [{ from: 'art/rock.png', to: 'art/s/rock.png' }]))).code).toBe('CONFLICT');
    expect((await failure(e.ops.trash(e.project.id, ['art/rock.png']))).code).toBe('CONFLICT');
    expect(e.asked).toHaveLength(0);
  });

  it('sends files to the Recycle Bin only after the permission and a window, never deleting them itself', async () => {
    const e = await env();
    e.index.scan(e.project.id);
    const preview = e.ops.previewTrash(e.project.id, ['art/rock.png', 'audio/boom.wav']);
    expect(preview).toMatchObject({ kind: 'trash', problems: [], items: [{ from: 'art/rock.png', to: null }, { from: 'audio/boom.wav', to: null }] });
    expect(preview.warnings[0]).toContain('Recycle Bin');
    e.answer.yes = false;
    expect(await e.ops.trash(e.project.id, ['art/rock.png'])).toEqual({ done: false, count: 0 });
    expect(e.trashed).toEqual([]);
    e.answer.yes = true;
    expect(await e.ops.trash(e.project.id, ['art/rock.png', 'audio/boom.wav'])).toEqual({ done: true, count: 2 });
    expect(e.trashed.map((p) => p.replace(/\\/g, '/').split('/').slice(-2).join('/'))).toEqual(['art/rock.png', 'audio/boom.wav']);
    expect(existsSync(join(e.root, 'art', 'rock.png'))).toBe(true); // the fake trash did not delete it: this code never calls a delete
    expect(e.index.search({ projectId: e.project.id, query: 'boom' }).total).toBe(0);
    expect(e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE scope = 'destructive'")?.n).toBe(1);
  });

  it('refuses to remove a sensitive file, a folder, a path outside and too many files at once', async () => {
    const e = await env();
    expect(e.ops.previewTrash(e.project.id, ['art/secret_key.png']).problems.join(' ')).toContain('credentials');
    expect(e.ops.previewTrash(e.project.id, ['art']).problems.join(' ')).toContain('not a regular file');
    expect(e.ops.previewTrash(e.project.id, ['../x.png']).problems.join(' ')).toContain('not inside');
    expect(e.ops.previewTrash(e.project.id, Array.from({ length: 201 }, (_, i) => `f${i}.png`)).problems.join(' ')).toContain('At most 200');
    expect(e.ops.previewMove(e.project.id, Array.from({ length: 201 }, (_, i) => ({ from: `f${i}.png`, to: `g${i}.png` }))).problems.join(' ')).toContain('At most 200');
  });
});

describe('export of the asset notes', () => {
  it('writes rows that the export schemas accept, including the task links', async () => {
    const e = await env();
    e.index.scan(e.project.id);
    e.index.annotate({ projectId: e.project.id, relativePath: 'art/rock.png', note: 'n', source: 's', usage: 'u', taskIds: [e.task('t').id] });
    for (const id of ['tracked_assets', 'asset_details', 'asset_task_refs']) {
      const table = assetTables.find((t) => t.id === id);
      const rows = e.db.all<Record<string, string | number | null>>(`SELECT * FROM ${id}`);
      expect(rows).toHaveLength(1);
      for (const row of rows) expect(() => table?.schema.parse(row)).not.toThrow();
    }
  });

  it('registers source and task-link tables after the tracked assets they point at', () => {
    const ids = assetTables.map((t) => t.id);
    expect(ids).toEqual(['tracked_assets', 'asset_briefs', 'asset_details', 'asset_task_refs']);
    expect(assetTables.find((t) => t.id === 'asset_details')?.parents).toEqual([{ column: 'asset_id', table: 'tracked_assets', parentColumn: 'id' }]);
    expect(dirname('x/y')).toBe('x');
  });
});

describe('the asset brief document', () => {
  it('writes the requirements as a document, flags what is still undecided, and never claims the app makes the asset', async () => {
    const e = await env();
    const task = e.task('Furnish the lobby');
    const brief = e.assets.saveBrief({ projectId: e.project.id, fields: { name: 'Lobby chair', assetType: 'static-mesh', engine: 'unreal', purpose: 'Seating in the lobby', scale: '1 unit = 1 cm; seat height 45 cm', formats: 'FBX', textures: '', performance: '', integration: 'Content/Props/Lobby', notes: 'Match the sofa', taskId: task.id, assetId: null } });
    const doc = e.assets.document(brief.id);
    expect(doc.text).toContain('# Asset brief: Lobby chair');
    expect(doc.text).toContain('Suggested file name: `SM_LobbyChair`');
    expect(doc.text).toContain('Needed for the task: Furnish the lobby');
    expect(doc.text).toContain('## Scale\n1 unit = 1 cm; seat height 45 cm');
    expect(doc.text).toContain('## Textures and materials\nNot specified yet.');
    expect(doc.text).toContain('Do not guess numbers');
    expect(doc.text).toContain('## Notes\nMatch the sofa');
    expect(doc.missing).toEqual(['Textures and materials', 'Performance limits']);
    expect(doc.text).toContain('Still to decide before this is handed to anyone: Textures and materials, Performance limits.');
    expect(doc.text).toContain('does not generate models or textures');
    expect((await failure(Promise.resolve().then(() => e.assets.document('nope')))).code).toBe('NOT_FOUND');
  });
});
