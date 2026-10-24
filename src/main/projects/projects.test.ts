import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, parse } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { copyFixture, snapshotTree } from '../../../test/helpers/tree';
import { createActivityLog, createRedactor } from '../logging';
import { detectProject } from './detect';
import { createProjectRegistry } from './registry';

afterEach(removeTempDirs);

describe('detectProject', () => {
  it.each([
    [
      'unreal-game',
      { type: 'unreal', engine: 'Unreal Engine', engineVersion: '5.4', confidence: 'confirmed' },
      'Backrooms.uproject',
    ],
    [
      'unreal-source-build',
      { type: 'unreal', engine: 'Unreal Engine', confidence: 'confirmed' },
      'Game.uproject',
    ],
    [
      'unity-game',
      { type: 'unity', engine: 'Unity', engineVersion: '2022.3.20f1', confidence: 'confirmed' },
      'ProjectSettings/ProjectVersion.txt',
    ],
    [
      'godot-game',
      { type: 'godot', engine: 'Godot', engineVersion: '4.3', confidence: 'confirmed' },
      'project.godot',
    ],
    [
      'vite-web',
      { type: 'web-vite', engine: 'Vite', engineVersion: '^5.4.0', confidence: 'confirmed' },
      'vite.config.ts',
    ],
    ['plain-web', { type: 'web', confidence: 'inferred' }, 'package.json'],
    ['dotnet-lib', { type: 'general-code', confidence: 'confirmed' }, 'Library.sln'],
    ['rust-tool', { type: 'general-code', confidence: 'confirmed' }, 'Cargo.toml'],
    ['blender-only', { type: 'custom', engine: 'Blender', confidence: 'inferred' }, 'scene.blend'],
    ['empty-custom', { type: 'custom', confidence: 'inferred' }, '.'],
  ])('%s', (name, expected, evidencePath) => {
    const detection = detectProject(copyFixture(name));
    expect(detection).toMatchObject(expected);
    expect(detection.evidence.map((e) => e.path)).toContain(evidencePath);
    if (!('engineVersion' in expected)) expect(detection.engineVersion).toBeUndefined();
  });

  it('never classifies by folder name: a folder called "unreal" with only a package.json is a web project', () => {
    const root = copyFixture('unreal');
    expect(root.toLowerCase().endsWith('unreal')).toBe(true);
    const detection = detectProject(root);
    expect(detection.type).toBe('web');
    expect(detection.evidence.map((e) => e.path)).toEqual(['package.json']);
  });

  it('picks the most specific type and keeps the other evidence: Unreal beats the Vite tooling beside it, Unity beats its .sln', () => {
    const game = detectProject(copyFixture('game-with-tooling'));
    expect(game.type).toBe('unreal');
    expect(game.evidence.map((e) => e.path).sort()).toEqual(['Game.uproject', 'package.json']);
    const unity = detectProject(copyFixture('unity-game'));
    expect(unity.type).toBe('unity');
    expect(unity.evidence.map((e) => e.path).sort()).toEqual([
      'Game.sln',
      'ProjectSettings/ProjectVersion.txt',
    ]);
  });

  it('does not read sensitive files or follow into them, and does not copy file contents into the evidence', () => {
    const root = copyFixture('secrets-around');
    writeFileSync(join(root, '.env'), 'API_KEY=sk-ant-api03-ShouldNeverBeRead0123456789');
    const detection = detectProject(root);
    expect(JSON.stringify(detection)).not.toContain('sk-ant');
    expect(detection.evidence.map((e) => e.path)).not.toContain('.env');
  });

  it('survives unreadable or hostile files: broken JSON, huge files, a package.json that is a folder', () => {
    const broken = makeTempDir();
    writeFileSync(join(broken, 'Game.uproject'), '{ not json');
    writeFileSync(join(broken, 'package.json'), '[1, 2');
    expect(detectProject(broken).type).toBe('unreal');

    const huge = makeTempDir();
    writeFileSync(
      join(huge, 'package.json'),
      `{"devDependencies":{"vite":"1"},"pad":"${'x'.repeat(2 * 1024 * 1024)}"}`,
    );
    expect(detectProject(huge).type).toBe('web'); // too big to read, so no Vite claim

    const odd = makeTempDir();
    mkdirSync(join(odd, 'package.json'));
    expect(detectProject(odd).type).toBe('custom');
  });
});

async function setup() {
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const activity = createActivityLog({ db, redactor: createRedactor(), logger });
  const protectedDir = makeTempDir();
  let n = 0;
  const open = () =>
    createProjectRegistry({
      db,
      activity,
      logger,
      protectedDirs: [protectedDir],
      now: () => new Date(Date.UTC(2026, 9, 24, 1, 0, n++)),
      newId: () => `p${n}`,
    });
  return { db, activity, protectedDir, registry: open(), open };
}

const errorOf = (fn: () => unknown): AppError => {
  try {
    fn();
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected an error');
};

describe('ProjectRegistry', () => {
  it('registers a folder with its detected type, evidence and a name from the folder, as active', async () => {
    const { registry } = await setup();
    const root = copyFixture('godot-game');
    const project = registry.add(root);
    expect(project).toMatchObject({
      name: 'godot-game',
      type: 'godot',
      typeSource: 'detected',
      engine: 'Godot',
      engineVersion: '4.3',
      status: 'active',
      folderExists: true,
      tags: [],
      detection: { type: 'godot', confidence: 'confirmed' },
    });
    expect(project.rootPath.toLowerCase()).toBe(root.toLowerCase());
    expect(registry.list().map((p) => p.id)).toEqual([project.id]);
  });

  it('changes no file: not on add, edit, override, re-detect, pause or removal (sizes, times and hashes all equal)', async () => {
    const { registry } = await setup();
    const root = copyFixture('game-with-tooling');
    const before = snapshotTree(root);
    const project = registry.add(root);
    registry.update({
      id: project.id,
      name: 'Renamed',
      tags: ['horror', 'ue5'],
      instructions: 'Be careful.',
      description: 'x',
    });
    registry.update({ id: project.id, typeOverride: 'custom' });
    registry.redetect(project.id);
    registry.update({ id: project.id, typeOverride: null });
    registry.update({ id: project.id, status: 'paused' });
    expect(snapshotTree(root)).toEqual(before);
    registry.remove(project.id);
    expect(snapshotTree(root)).toEqual(before);
    expect(registry.list()).toEqual([]);
  });

  it.each([
    ['a relative path', () => 'relative/folder', 'INVALID_INPUT'],
    ['a missing folder', () => join(makeTempDir(), 'nope'), 'NOT_FOUND'],
    [
      'a file',
      () => {
        const file = join(makeTempDir(), 'a.txt');
        writeFileSync(file, 'x');
        return file;
      },
      'INVALID_INPUT',
    ],
    ['a whole drive', () => parse(process.cwd()).root, 'INVALID_INPUT'],
  ])('refuses %s', async (_name, folder, code) => {
    const { registry } = await setup();
    expect(errorOf(() => registry.add(folder())).code).toBe(code);
    expect(registry.list()).toEqual([]);
  });

  it("refuses the app's own data folder", async () => {
    const { registry, protectedDir } = await setup();
    expect(errorOf(() => registry.add(protectedDir)).message).toContain('own data folder');
  });

  it('rejects the same folder twice however it is spelled, and says which project has it', async () => {
    const { registry } = await setup();
    const root = copyFixture('vite-web');
    registry.add(root);
    for (const spelling of [root, `${root}\\`, `${root}/`, root.toUpperCase(), root.toLowerCase()]) {
      const error = errorOf(() => registry.add(spelling));
      expect(error.code, spelling).toBe('ALREADY_EXISTS');
      expect(error.message).toContain('vite-web');
    }
    expect(registry.list()).toHaveLength(1);
  });

  it('edits fields, de-duplicates and trims tags, and records activity for the change', async () => {
    const { registry, activity } = await setup();
    const project = registry.add(copyFixture('plain-web'));
    const updated = registry.update({
      id: project.id,
      name: 'My Site',
      tags: ['  web ', 'web', 'site', ''],
      description: 'A site',
      instructions: 'Use tabs.',
    });
    expect(updated).toMatchObject({
      name: 'My Site',
      tags: ['web', 'site'],
      description: 'A site',
      instructions: 'Use tabs.',
    });
    expect(activity.list({ limit: 5, projectId: project.id }).map((e) => e.kind)).toEqual([
      'project.updated',
      'project.added',
    ]);
    // No change, no event.
    registry.update({ id: project.id, name: 'My Site' });
    expect(activity.list({ limit: 5, projectId: project.id })).toHaveLength(2);
  });

  it('lets the user override the type and go back, keeping the detection result', async () => {
    const { registry } = await setup();
    const project = registry.add(copyFixture('unreal-game'));
    const forced = registry.update({ id: project.id, typeOverride: 'custom' });
    expect(forced).toMatchObject({ type: 'custom', typeSource: 'manual', detection: { type: 'unreal' } });
    expect(forced.engine).toBeUndefined();
    // Re-reading the files keeps the manual choice.
    expect(registry.redetect(project.id)).toMatchObject({ type: 'custom', typeSource: 'manual' });
    // Forcing the type the files already say is not an override.
    expect(registry.update({ id: project.id, typeOverride: 'unreal' })).toMatchObject({
      type: 'unreal',
      typeSource: 'manual',
      engineVersion: '5.4',
    });
    expect(registry.update({ id: project.id, typeOverride: null })).toMatchObject({
      type: 'unreal',
      typeSource: 'detected',
      engine: 'Unreal Engine',
    });
  });

  it('re-detects after the project changes on disk', async () => {
    const { registry } = await setup();
    const root = copyFixture('empty-custom');
    const project = registry.add(root);
    expect(project.type).toBe('custom');
    writeFileSync(join(root, 'project.godot'), 'config_version=5\nconfig/features=PackedStringArray("4.2")');
    expect(registry.redetect(project.id)).toMatchObject({
      type: 'godot',
      engineVersion: '4.2',
      typeSource: 'detected',
    });
  });

  it('pauses and resumes, and reports a folder that went missing without losing the project', async () => {
    const { registry, activity } = await setup();
    const root = copyFixture('rust-tool');
    const project = registry.add(root);
    expect(registry.update({ id: project.id, status: 'paused' }).status).toBe('paused');
    expect(registry.update({ id: project.id, status: 'active' }).status).toBe('active');
    expect(activity.list({ limit: 3, projectId: project.id }).map((e) => e.kind)).toEqual([
      'project.resumed',
      'project.paused',
      'project.added',
    ]);

    rmSync(root, { recursive: true, force: true });
    expect(registry.get(project.id)).toMatchObject({ folderExists: false, status: 'active' });
    expect(errorOf(() => registry.redetect(project.id))).toMatchObject({ code: 'NOT_FOUND' });
    expect(registry.list()).toHaveLength(1);
    registry.remove(project.id);
    expect(registry.list()).toEqual([]);
  });

  it('keeps projects, overrides and detections across a restart', async () => {
    const { registry, open } = await setup();
    const project = registry.add(copyFixture('unity-game'));
    registry.update({ id: project.id, typeOverride: 'general-code', tags: ['a'] });
    const again = open().get(project.id);
    expect(again).toMatchObject({
      type: 'general-code',
      typeSource: 'manual',
      tags: ['a'],
      detection: { type: 'unity', engineVersion: '2022.3.20f1' },
    });
  });

  it('reports an unknown id as NOT_FOUND', async () => {
    const { registry } = await setup();
    expect(errorOf(() => registry.update({ id: 'nope', name: 'x' })).code).toBe('NOT_FOUND');
    expect(errorOf(() => registry.remove('nope')).code).toBe('NOT_FOUND');
    expect(registry.get('nope')).toBeUndefined();
  });

  it('removal records an event that says the folder was not touched', async () => {
    const { registry, activity } = await setup();
    const project = registry.add(copyFixture('dotnet-lib'));
    registry.remove(project.id);
    expect(activity.list({ limit: 1 })[0]).toMatchObject({ kind: 'project.removed', projectId: project.id });
    expect(activity.list({ limit: 1 })[0]?.summary).toContain('folder was not touched');
  });
});
