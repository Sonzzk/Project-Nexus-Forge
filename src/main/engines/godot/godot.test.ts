import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import { createFakeRunner } from '../../../../test/helpers/fake-runner';
import { openMigratedDb } from '../../../../test/helpers/db';
import { memoryLogger } from '../../../../test/helpers/logger';
import { removeTempDirs } from '../../../../test/helpers/temp';
import { copyFixture, snapshotTree } from '../../../../test/helpers/tree';
import { createActivityLog, createRedactor } from '../../logging';
import { createProjectRegistry } from '../../projects';
import { createPermissionService } from '../../security';
import { cfgBool, cfgGet, cfgString, cfgStrings, parseCfg } from './cfg';
import { godotCapabilities, godotCommands, resolveGodot } from './commands';
import { godotContextText } from './context';
import { discoverGodot, parseGodotFileName, parseGodotVersion } from './installs';
import { describeGodotProject } from './project';
import { createGodotService } from './service';

afterEach(removeTempDirs);

describe('the ConfigFile reader', () => {
  it('reads sections, comments, quoted strings, arrays and values that run over several lines', () => {
    const cfg = parseCfg('; comment\nconfig_version=5\n\n[a]\nname="x \\"y\\""\nlist=PackedStringArray("1", "2")\nlong="line one\nline two"\nflag=true\n[b]\nk=1\n');
    expect(cfgGet(cfg, '', 'config_version')).toBe('5');
    expect(cfgString(cfgGet(cfg, 'a', 'name'))).toBe('x "y"');
    expect(cfgStrings(cfgGet(cfg, 'a', 'list'))).toEqual(['1', '2']);
    expect(cfgString(cfgGet(cfg, 'a', 'long'))).toBe('line one\nline two');
    expect(cfgBool(cfgGet(cfg, 'a', 'flag'))).toBe(true);
    expect(cfgGet(cfg, 'b', 'k')).toBe('1');
  });

  it('treats __proto__ as an ordinary key and does not choke on garbage', () => {
    const cfg = parseCfg('[__proto__]\npolluted=1\nnot a line\n=x\n[unterminated\nk="open');
    expect(cfgGet(cfg, '__proto__', 'polluted')).toBe('1');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(cfgString('not quoted')).toBeUndefined();
  });
});

describe('describing a Godot project', () => {
  it('reads the project, presets, add-ons, autoloads, classes and tests without changing anything', () => {
    const root = copyFixture('godot-project');
    const before = snapshotTree(root);
    const p = describeGodotProject(root);
    expect(p).toMatchObject({ name: 'Hall Runner', configVersion: 5, engineVersion: '4.3', renderer: 'Forward Plus', csharp: false, mainScene: 'res://scenes/main.tscn' });
    expect(p?.autoloads).toEqual([{ name: 'Game', path: 'res://scripts/game.gd' }, { name: 'Music', path: 'res://scripts/music.gd' }]);
    expect(p?.enabledPlugins).toEqual(['res://addons/gut/plugin.cfg']);
    expect(p?.addons).toEqual([{ folder: 'gut', name: 'Gut', version: '9.3.0' }, { folder: 'other', name: 'other', version: '' }]);
    expect(p?.scripts).toMatchObject({ gdscript: 4, scenes: 1, truncated: false }); // add-on code is not counted
    expect(p?.scripts.classes).toEqual([{ name: 'Player', path: 'scripts/player.gd', extends: 'CharacterBody2D' }]);
    expect(p?.tests).toEqual({ framework: 'gut', directory: 'test', hasConfig: false });
    expect(snapshotTree(root)).toEqual(before);
  });

  it('keeps only name, platform, runnable and path of each preset, and says why a preset has no command', () => {
    const p = describeGodotProject(copyFixture('godot-project'));
    expect(p?.presets).toEqual([
      { name: 'Windows Desktop', platform: 'Windows Desktop', runnable: true, exportPath: 'builds/game.exe', skipped: '' },
      { name: 'Web', platform: 'Web', runnable: false, exportPath: '', skipped: expect.stringContaining('no export path') as unknown },
      { name: 'Linux "Beta"', platform: 'Linux', runnable: true, exportPath: '../outside/game.x86_64', skipped: expect.stringContaining('leaves the project') as unknown },
      { name: 'Android', platform: 'Android', runnable: true, exportPath: 'not-made/app.apk', skipped: expect.stringContaining('does not exist') as unknown },
    ]);
    expect(JSON.stringify(p)).not.toContain('do-not-show-this-secret');
  });

  it('returns nothing for a folder without a readable project.godot, and flags a Godot 3 project', () => {
    expect(describeGodotProject(copyFixture('empty-custom'))).toBeUndefined();
    const godot3 = describeGodotProject(copyFixture('godot-game'));
    expect(godot3?.configVersion).toBe(5);
    expect(describeGodotProject(copyFixture('audit-godot'))?.engineVersion).toBe('4.3');
  });
});

describe('Godot downloads', () => {
  it('parses the version string and the download file name', () => {
    expect(parseGodotVersion('4.3.stable.official.77dcf97d8\n')).toEqual({ version: '4.3', release: 'stable', mono: false });
    expect(parseGodotVersion('4.4.1.stable.mono.official.abc')).toEqual({ version: '4.4.1', release: 'stable', mono: true });
    expect(parseGodotVersion('Godot Engine v4.3')).toBeNull();
    expect(parseGodotFileName('Godot_v4.3-stable_mono_win64.exe')).toEqual({ version: '4.3', release: 'stable', mono: true });
    expect(parseGodotFileName('godot.exe')).toBeNull();
  });

  it('finds editor and console programs in added folders, default folders and PATH, newest first, without duplicates', async () => {
    const dirs: Record<string, string[]> = {
      'C:\\G\\one': ['Godot_v4.3-stable_win64.exe', 'Godot_v4.3-stable_win64_console.exe', 'readme.txt'],
      'C:\\G\\two': ['Godot_v4.4-stable_win64.exe'],
      'C:\\G\\root': ['Godot_v3.5', 'notes.txt'],
      'C:\\G\\root\\Godot_v3.5': ['Godot_v3.5-stable_win64.exe', 'Godot_v3.5-stable_win64_console.exe'],
      'C:\\bin': ['godot.exe'],
    };
    const installs = await discoverGodot({
      configured: () => ['C:\\G\\one', 'C:\\G\\one'],
      defaultRoots: () => ['C:\\G\\root', 'C:\\G\\two'],
      onPath: () => 'C:\\bin\\godot.exe',
      listDirectory: (p) => dirs[p] ?? [],
      versionOf: (exe) => Promise.resolve(exe.includes('v4.3') ? '4.3.stable.official.77dcf97d8' : null),
    });
    expect(installs.map((i) => [i.version, i.source, i.exe !== null, i.consoleExe !== null])).toEqual([
      ['4.4', 'default-folder', true, false],
      ['4.3', 'configured', true, true],
      ['3.5', 'default-folder', true, true],
      [null, 'path', true, false],
    ]);
    expect(installs[0]?.note).toContain('could not be read'); // read from the file name instead
    expect(installs[1]).toMatchObject({ release: 'stable', note: '' });
    expect(installs[1]?.exe).toBe('C:\\G\\one\\Godot_v4.3-stable_win64.exe');
  });
});

const installOf = (overrides: Partial<Parameters<typeof resolveGodot>[1][number]> = {}) => ({ folder: 'C:\\G\\one', exe: 'C:\\G\\one\\Godot_v4.3-stable_win64.exe', consoleExe: 'C:\\G\\one\\Godot_v4.3-stable_win64_console.exe', version: '4.3', release: 'stable', mono: false, source: 'configured' as const, note: '', ...overrides });

describe('choosing the install and the commands', () => {
  it('matches major.minor and the C# build, and never guesses another version', () => {
    const project = describeGodotProject(copyFixture('godot-project'));
    if (project === undefined) throw new Error('fixture');
    expect(resolveGodot(project, [installOf({ version: '4.4' }), installOf()]).install?.version).toBe('4.3');
    expect(resolveGodot(project, [installOf({ version: '4.4' })])).toMatchObject({ install: undefined, why: expect.stringContaining('asks for Godot 4.3') as unknown });
    expect(resolveGodot(project, [installOf({ mono: true })])).toMatchObject({ install: undefined, why: expect.stringContaining('.NET build') as unknown });
    expect(resolveGodot({ ...project, csharp: true }, [installOf()])).toMatchObject({ install: undefined, why: expect.stringContaining('uses C#') as unknown });
    expect(resolveGodot({ ...project, engineVersion: null }, [installOf()])).toMatchObject({ install: undefined, why: expect.stringContaining('does not guess') as unknown });
  });

  it('builds import, export (each preset in release and debug) and GUT commands only from what the project holds', () => {
    const root = 'C:\\Games\\Hall';
    const project = describeGodotProject(copyFixture('godot-project'));
    if (project === undefined) throw new Error('fixture');
    const cmds = godotCommands(project, root, installOf());
    const exe = 'C:\\G\\one\\Godot_v4.3-stable_win64.exe';
    expect(cmds.map((c) => c.label)).toEqual(['Godot: import resources (headless)', 'Godot: export Windows Desktop (release)', 'Godot: export Windows Desktop (debug)', 'Godot: run GUT tests']);
    expect(cmds[0]?.argv).toEqual([exe, '--headless', '--path', root, '--import']);
    expect(cmds[1]?.argv).toEqual([exe, '--headless', '--path', root, '--export-release', 'Windows Desktop', 'builds/game.exe']);
    expect(cmds[2]?.argv).toEqual([exe, '--headless', '--path', root, '--export-debug', 'Windows Desktop', 'builds/game.exe']);
    expect(cmds[3]?.argv).toEqual([exe, '--headless', '--path', root, '-d', '-s', 'addons/gut/gut_cmdln.gd', '-gdir=res://test', '-gexit']);
    expect(cmds.every((c) => c.writes && (c.timeoutMs ?? 0) > 0)).toBe(true);
    expect(cmds.some((c) => c.argv.some((a) => /outside|not-made|Beta|Android/.test(a)))).toBe(false);
  });

  it('offers nothing without a console build, without an install, or for a Godot 3 project', () => {
    const project = describeGodotProject(copyFixture('godot-project'));
    if (project === undefined) throw new Error('fixture');
    expect(godotCommands(project, 'C:\\x', undefined)).toEqual([]);
    expect(godotCommands(project, 'C:\\x', installOf({ exe: null, consoleExe: null }))).toEqual([]);
    expect(godotCommands(project, 'C:\\x', installOf({ exe: null }))[0]?.argv[0]).toMatch(/_console\.exe$/); // the wrapper is only a fallback
    expect(godotCommands({ ...project, configVersion: 4 }, 'C:\\x', installOf())).toEqual([]);
    expect(godotCommands({ ...project, configVersion: null }, 'C:\\x', installOf())).toEqual([]);
  });

  it('uses .gutconfig.json when the project has one, and offers no test command for other frameworks', () => {
    const project = describeGodotProject(copyFixture('godot-project'));
    if (project === undefined) throw new Error('fixture');
    const withConfig = godotCommands({ ...project, tests: { framework: 'gut', directory: null, hasConfig: true } }, 'C:\\x', installOf()).find((c) => c.label.includes('GUT'));
    expect(withConfig?.argv.slice(-4)).toEqual(['-d', '-s', 'addons/gut/gut_cmdln.gd', '-gexit']);
    expect(godotCommands({ ...project, tests: { framework: 'gdunit4', directory: 'test', hasConfig: false } }, 'C:\\x', installOf()).some((c) => c.label.includes('test'))).toBe(false);
  });

  it('reports each capability with a reason', () => {
    const project = describeGodotProject(copyFixture('godot-project'));
    if (project === undefined) throw new Error('fixture');
    const states = (r: ReturnType<typeof godotCapabilities>): Record<string, string> => Object.fromEntries(r.map((c) => [c.id, c.state]));
    expect(states(godotCapabilities({ project, installs: [installOf()], resolved: installOf(), resolveNote: '' }))).toEqual({ detect: 'implemented', installs: 'implemented', editor: 'implemented', import: 'implemented', export: 'implemented', tests: 'implemented', context: 'implemented', output: 'implemented', 'script-check': 'unavailable' });
    const none = godotCapabilities({ project, installs: [], resolved: undefined, resolveNote: 'not installed' });
    expect(states(none)).toMatchObject({ installs: 'awaiting-configuration', editor: 'awaiting-configuration', import: 'awaiting-configuration', export: 'awaiting-configuration' });
    expect(none.find((c) => c.id === 'import')?.reason).toBe('not installed');
    expect(states(godotCapabilities({ project: undefined, installs: [], resolved: undefined, resolveNote: '' })).detect).toBe('unavailable');
  });

  it('describes the project for context packs without script bodies', () => {
    const project = describeGodotProject(copyFixture('godot-project'));
    if (project === undefined) throw new Error('fixture');
    const text = godotContextText(project);
    expect(text).toContain('Godot 4.3, renderer Forward Plus');
    expect(text).toContain('- Player extends CharacterBody2D (scripts/player.gd)');
    expect(text).toContain('Game (res://scripts/game.gd)');
    expect(text).not.toContain('move_and_slide');
    expect(text).not.toContain('do-not-show-this-secret');
  });
});

async function env() {
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const activity = createActivityLog({ db, redactor: createRedactor(), logger });
  const projects = createProjectRegistry({ db, activity, logger });
  const asked: { title: string; detail?: string | undefined }[] = [];
  const answer = { yes: true };
  const confirm = (o: { title: string; message: string; detail?: string }): Promise<boolean> => (asked.push(o), Promise.resolve(answer.yes));
  const permissions = createPermissionService({ db, projects, activity, confirm });
  const opened: string[] = [];
  const picked: { path: string | undefined } = { path: undefined };
  const empty = copyFixture('empty-custom');
  const runner = createFakeRunner((spec) => (spec.args[0] === '--version' ? { stdout: spec.executable.includes('v4.4') ? '4.4.stable.official.abc\n' : '4.3.stable.official.77dcf97d8\n' } : spec.args.includes('--editor') ? { hold: true } : {}));
  const service = createGodotService({ db, projects, runner, activity, permissions, confirm, logger, openPath: (full) => (opened.push(full), Promise.resolve('')), pickFolder: () => Promise.resolve(picked.path), env: () => ({ ProgramFiles: join(empty, 'no'), LOCALAPPDATA: join(empty, 'no2') }), startupCheckMs: 5 });
  const addDownload = async (name = 'Godot_4.3'): Promise<string> => {
    picked.path = copyFixture(`engines/${name}`);
    await service.addPath();
    return picked.path;
  };
  return { db, projects, service, asked, answer, opened, picked, addDownload, runner };
}

const failure = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a failure');
};

describe('the Godot service', () => {
  it('describes a project, finds its download by running --version, and lists the commands', async () => {
    const e = await env();
    const project = e.projects.add(copyFixture('godot-project'));
    const noDownload = await e.service.view(project.id);
    expect(noDownload).toMatchObject({ isGodot: true, resolved: null, commands: [] });
    expect(noDownload.capabilities.find((c) => c.id === 'import')?.state).toBe('awaiting-configuration');
    const folder = await e.addDownload();
    const view = await e.service.view(project.id);
    expect(view.installs).toMatchObject([{ folder, version: '4.3', release: 'stable', source: 'configured' }]);
    expect(view.resolved).toMatchObject({ folder, version: '4.3' });
    expect(view.commands.map((c) => c.label)).toEqual(['Godot: import resources (headless)', 'Godot: export Windows Desktop (release)', 'Godot: export Windows Desktop (debug)', 'Godot: run GUT tests']);
    expect(e.runner.started.filter((s) => s.args[0] === '--version').map((s) => s.executable)).toEqual([join(folder, 'Godot_v4.3-stable_win64.exe')]);
  });

  it('hands commands to the command service only after the installs were looked at', async () => {
    const e = await env();
    const project = e.projects.add(copyFixture('godot-project'));
    await e.addDownload();
    expect(e.service.commandsFor(project.id)).toEqual([]);
    await e.service.ensure();
    expect(e.service.commandsFor(project.id)).toHaveLength(4);
    expect(e.service.commandsFor('missing')).toEqual([]);
    expect(e.service.commandsFor(e.projects.add(copyFixture('empty-custom')).id)).toEqual([]);
  });

  it('starts the editor only after the person agrees, owns it, and stops it on request', async () => {
    const e = await env();
    const root = copyFixture('godot-project');
    const project = e.projects.add(root);
    await e.addDownload();
    e.answer.yes = false;
    expect(await e.service.launchEditor(project.id)).toEqual({ started: false });
    expect(e.runner.started.some((s) => s.args.includes('--editor'))).toBe(false);
    e.answer.yes = true;
    expect(await e.service.launchEditor(project.id)).toEqual({ started: true });
    const spec = e.runner.started.find((s) => s.args.includes('--editor'));
    expect(spec).toMatchObject({ args: ['--editor', '--path', root], owner: { kind: 'engine', id: `godot-editor-${project.id}` } });
    expect(spec?.executable).toMatch(/Godot_v4\.3-stable_win64\.exe$/);    expect(e.asked.at(-1)?.detail).toContain('re-save project files');
    expect((await e.service.view(project.id)).editor.running).toBe(true);
    expect((await failure(e.service.launchEditor(project.id))).code).toBe('CONFLICT');
    expect(await e.service.stopEditor(project.id)).toEqual({ stopped: true });
    expect(e.runner.cancelled).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect((await e.service.view(project.id)).editor.running).toBe(false);
    expect(await e.service.stopEditor(project.id)).toEqual({ stopped: false });
  });

  it('reports an editor that cannot start or quits at once instead of showing it as running', async () => {
    const { db } = await openMigratedDb();
    const logger = memoryLogger();
    const activity = createActivityLog({ db, redactor: createRedactor(), logger });
    const projects = createProjectRegistry({ db, activity, logger });
    const confirm = (): Promise<boolean> => Promise.resolve(true);
    const permissions = createPermissionService({ db, projects, activity, confirm });
    const runner = createFakeRunner((spec) => (spec.args[0] === '--version' ? { stdout: '4.3.stable.official.x' } : { status: 'spawn-failed', exitCode: null, errorMessage: 'ENOENT' }));
    const picked = copyFixture('engines/Godot_4.3');
    const service = createGodotService({ db, projects, runner, activity, permissions, confirm, logger, openPath: () => Promise.resolve(''), pickFolder: () => Promise.resolve(picked), env: () => ({}), startupCheckMs: 200 });
    await service.addPath();
    const project = projects.add(copyFixture('godot-project'));
    const error = await failure(service.launchEditor(project.id));
    expect(error).toMatchObject({ code: 'TOOL_FAILED', hint: 'ENOENT' });
    expect((await service.view(project.id)).editor.running).toBe(false);
  });

  it('refuses to start the editor when no matching download exists, and for a folder that is not a Godot project', async () => {
    const e = await env();
    const project = e.projects.add(copyFixture('godot-project'));
    expect((await failure(e.service.launchEditor(project.id))).code).toBe('NOT_FOUND');
    await e.addDownload('Godot_4.4-no-console');
    expect((await failure(e.service.launchEditor(project.id))).message).toContain('No matching');
    expect((await failure(e.service.launchEditor(e.projects.add(copyFixture('empty-custom')).id))).code).toBe('NOT_FOUND');
    expect(e.runner.started.some((s) => s.args.includes('--editor'))).toBe(false);
  });

  it('adds and removes download folders by position, accepts only a folder with a Godot program, and opens only folders inside the project', async () => {
    const e = await env();
    e.picked.path = copyFixture('empty-custom');
    expect((await failure(e.service.addPath())).code).toBe('INVALID_INPUT');
    await e.addDownload();
    expect(e.service.paths()).toHaveLength(1);
    expect(await e.service.addPath()).toEqual({ added: false });
    expect((await failure(Promise.resolve().then(() => e.service.removePath(5)))).code).toBe('NOT_FOUND');
    e.service.removePath(0);
    expect(e.service.paths()).toEqual([]);
    e.picked.path = undefined;
    expect(await e.service.addPath()).toEqual({ added: false });

    const root = copyFixture('godot-project');
    const project = e.projects.add(root);
    await e.service.open(project.id, 'project');
    await e.service.open(project.id, 'addons');
    expect(e.opened).toEqual([root, join(root, 'addons')]);
    expect((await failure(e.service.open(project.id, '..' as never))).code).toBe('INVALID_INPUT');
  });
});
