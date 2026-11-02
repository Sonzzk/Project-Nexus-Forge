import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openMigratedDb } from '../../../../test/helpers/db';
import { memoryLogger } from '../../../../test/helpers/logger';
import { removeTempDirs } from '../../../../test/helpers/temp';
import { copyFixture } from '../../../../test/helpers/tree';
import { createActivityLog, createRedactor } from '../../logging';
import { createProjectRegistry } from '../../projects';
import { createMemoryService, createPackService } from '../../scanning';
import { unrealContextText } from './context';
import { describeUnrealProject } from './project';

afterEach(removeTempDirs);

function describeProject(fixture: string) {
  const described = describeUnrealProject(copyFixture(fixture));
  if (described === undefined) throw new Error(`${fixture} is not an Unreal project`);
  return described;
}

describe('the Unreal summary for context packs', () => {
  it('names the targets, modules, plugins, default map and content, and says binary assets must not be edited as files', () => {
    const text = unrealContextText(describeProject('unreal-cpp'));
    expect(text).toContain('## Unreal Engine project: Backrooms');
    expect(text).toContain('Engine association: 5.5; project version 0.3.1');
    expect(text).toContain('Targets: Backrooms (Game), BackroomsEditor (Editor)');
    expect(text).toContain('Modules: Backrooms (Runtime, Default), Hall (Runtime, PostConfigInit)');
    expect(text).toContain('Plugins enabled: ModelingToolsEditorMode');
    expect(text).toContain('Plugins disabled: OnlineSubsystem');
    expect(text).toContain('Plugins inside the project: Flicker');
    expect(text).toContain('Default map: /Game/Maps/Hall.Hall');
    expect(text).toContain('Content (3 assets');
    expect(text).toContain('- Characters: 2');
    expect(text).toContain('- /Game/Maps/Hall');
    expect(text).toContain('Do not edit them as files');
    expect(text).not.toContain('Token'); // the config file named like a secret is neither listed nor read
  });

  it('says a project with no C++ is Blueprint-only', () => {
    expect(unrealContextText(describeProject('unreal-blueprint'))).toContain('Blueprint-only (no C++ source)');
  });
});

describe('the engine item of a context pack', () => {
  async function env(fixture: string) {
    const { db } = await openMigratedDb();
    const logger = memoryLogger();
    const redactor = createRedactor();
    const activity = createActivityLog({ db, redactor, logger });
    const projects = createProjectRegistry({ db, activity, logger });
    const root = copyFixture(fixture);
    const project = projects.add(root);
    const memory = createMemoryService({ db, projects, activity, confirm: () => Promise.resolve(true) });
    const packs = createPackService({
      db, projects, memory, activity,
      limits: () => ({ maxFiles: 20_000, budgetMs: 8000 }),
      engineContext: (projectId) => {
        const found = projects.get(projectId);
        const described = found === undefined ? undefined : describeUnrealProject(found.rootPath);
        return described === undefined ? '' : unrealContextText(described);
      },
    });
    return { root, project, packs };
  }

  it('adds the summary to a pack of an Unreal project, with its reason, and flags the pack out of date when the project changes', async () => {
    const e = await env('unreal-cpp');
    const pack = await e.packs.build({ projectId: e.project.id, task: 'Make the hall flicker', extraFiles: [], budget: 8000, destination: '' });
    expect(pack.items.find((i) => i.kind === 'engine')).toMatchObject({ path: 'engine', reason: 'A summary of the engine project, read from its project files' });
    expect(pack.text).toContain('Unreal Engine project: Backrooms');
    const saved = e.packs.save(e.project.id, 'Flicker');
    expect((await e.packs.get(e.project.id, saved.id)).stale).toEqual([]);
    writeFileSync(join(e.root, 'Config', 'DefaultGame.ini'), '[/Script/EngineSettings.GeneralProjectSettings]\nProjectVersion=0.4.0\n');
    expect((await e.packs.get(e.project.id, saved.id)).stale.some((s) => s.path === 'engine' && s.change === 'changed')).toBe(true);
  });

  it('adds nothing for a project that is not Unreal', async () => {
    const e = await env('plain-web');
    const pack = await e.packs.build({ projectId: e.project.id, task: 'Fix the page', extraFiles: [], budget: 8000, destination: '' });
    expect(pack.items.some((i) => i.kind === 'engine')).toBe(false);
  });
});
