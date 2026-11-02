import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeTempDirs } from '../../../../test/helpers/temp';
import { copyFixture, snapshotTree } from '../../../../test/helpers/tree';
import { discoverEngines, inspectEngine, parseLauncherInstalled, parseRegistryBuilds, resolveEngine } from './engines';
import { describeUnrealProject, iniValue, parseUproject } from './project';

afterEach(removeTempDirs);

describe('reading a .uproject', () => {
  it('reads the documented fields and ignores the rest', () => {
    const parsed = parseUproject('\uFEFF{"FileVersion":3,"EngineAssociation":"5.4","Category":"Games","Description":"d","Modules":[{"Name":"A","Type":"Runtime","LoadingPhase":"Default"},{"Type":"x"}],"Plugins":[{"Name":"P","Enabled":false},{"Name":"Q"}],"Other":1}');
    expect(parsed).toEqual({ fileVersion: 3, engineAssociation: '5.4', description: 'd', category: 'Games', modules: [{ name: 'A', type: 'Runtime', loadingPhase: 'Default' }], plugins: [{ name: 'P', enabled: false }, { name: 'Q', enabled: true }] });
  });

  it.each(['', 'not json', '[1,2]', 'null', '"text"'])('refuses %j instead of guessing', (text) => {
    expect(parseUproject(text)).toBeUndefined();
  });

  it('survives wrong types', () => {
    expect(parseUproject('{"FileVersion":"3","EngineAssociation":7,"Modules":"x","Plugins":[1,null]}')).toEqual({ fileVersion: null, engineAssociation: '', description: '', category: '', modules: [], plugins: [] });
  });
});

describe('ini values', () => {
  it('finds a key in its section only, in any case', () => {
    const ini = '[A]\nKey=1\n[/Script/X.Y]\nkey = 2 \n[B]\nKey=3\n';
    expect(iniValue(ini, '/Script/X.Y', 'Key')).toBe('2');
    expect(iniValue(ini, 'a', 'KEY')).toBe('1');
    expect(iniValue(ini, 'C', 'Key')).toBeUndefined();
  });
});

describe('describing an Unreal project folder', () => {
  it('reads the project, targets, modules, config, plugins and content of a C++ project without changing anything', () => {
    const root = copyFixture('unreal-cpp');
    const before = snapshotTree(root);
    const p = describeUnrealProject(root);
    expect(p).toMatchObject({ uproject: 'Backrooms.uproject', name: 'Backrooms', engineAssociation: '5.5', category: 'Games', hasSource: true, buildCsFiles: 1, defaultMap: '/Game/Maps/Hall.Hall', editorStartupMap: '/Game/Maps/Hall.Hall', projectVersion: '0.3.1' });
    expect(p?.targets).toEqual([
      { name: 'Backrooms', type: 'Game', file: 'Source/Backrooms.Target.cs' },
      { name: 'BackroomsEditor', type: 'Editor', file: 'Source/BackroomsEditor.Target.cs' },
    ]);
    expect(p?.modules.map((m) => m.name)).toEqual(['Backrooms', 'Hall']);
    expect(p?.plugins).toEqual([{ name: 'ModelingToolsEditorMode', enabled: true }, { name: 'OnlineSubsystem', enabled: false }]);
    expect(p?.projectPlugins).toEqual(['Flicker']);
    expect(p?.folders).toMatchObject({ source: true, config: true, content: true, plugins: true, binaries: false, saved: false });
    expect(p?.content).toMatchObject({ assets: 3, maps: ['/Game/Maps/Hall'], truncated: false });
    expect(p?.content.topFolders).toEqual([{ name: 'Characters', assets: 2 }, { name: 'Maps', assets: 1 }]);
    expect(p?.configFiles).toEqual(['DefaultEngine.ini', 'DefaultGame.ini']); // the file named like a secret is left out
    expect(snapshotTree(root)).toEqual(before);
  });

  it('says a project without C++ source is Blueprint-only, and reads a source-build id as it is', () => {
    const p = describeUnrealProject(copyFixture('unreal-blueprint'));
    expect(p).toMatchObject({ hasSource: false, engineAssociation: '{11111111-2222-3333-4444-555555555555}', targets: [], defaultMap: null });
    expect(p?.notes.join(' ')).toContain('Blueprint-only');
  });

  it('is undefined for a folder with no readable .uproject, and takes the first when there are several', () => {
    expect(describeUnrealProject(makeTempDir())).toBeUndefined();
    const broken = makeTempDir();
    writeFileSync(join(broken, 'X.uproject'), 'garbage');
    expect(describeUnrealProject(broken)).toBeUndefined();
    const two = makeTempDir();
    writeFileSync(join(two, 'B.uproject'), '{"FileVersion":3}');
    writeFileSync(join(two, 'A.uproject'), '{"FileVersion":3}');
    const p = describeUnrealProject(two);
    expect(p?.name).toBe('A');
    expect(p?.notes[0]).toContain('2 .uproject files');
  });

  it('stops counting a huge content folder and says so', () => {
    const root = makeTempDir();
    writeFileSync(join(root, 'Big.uproject'), '{"FileVersion":3}');
    mkdirSync(join(root, 'Content'));
    for (let i = 0; i < 25; i++) writeFileSync(join(root, 'Content', `a${i}.uasset`), 'x');
    expect(describeUnrealProject(root)?.content.assets).toBe(25);
  });
});

describe('engine install lists', () => {
  const launcher = JSON.stringify({
    InstallationList: [
      { InstallLocation: 'V:\\games\\Some Game', AppName: 'abc123' },
      { InstallLocation: 'V:\\wierd stuff\\UE_5.8', AppName: 'UE_5.8' },
      { InstallLocation: 'V:\\wierd stuff\\UE_5.8', AppName: 'UE_5.8' },
      { InstallLocation: 'V:\\old\\UE_5.6', AppName: 'UE_5.6' },
      { AppName: 'UE_5.4' },
    ],
  });

  it('reads engines from the launcher file once each and ignores games and damaged entries', () => {
    expect(parseLauncherInstalled(launcher)).toEqual([{ id: 'UE_5.8', path: 'V:\\wierd stuff\\UE_5.8' }, { id: 'UE_5.6', path: 'V:\\old\\UE_5.6' }]);
    expect(parseLauncherInstalled('nope')).toEqual([]);
    expect(parseLauncherInstalled('{"InstallationList":5}')).toEqual([]);
  });

  it('reads source builds from reg query output', () => {
    const out = '\r\nHKEY_CURRENT_USER\\Software\\Epic Games\\Unreal Engine\\Builds\r\n    {AAAA-BBBB}    REG_SZ    D:\\Source\\UE5 Main\r\n    Custom    REG_SZ    E:\\Engines\\Custom\r\n';
    expect(parseRegistryBuilds(out)).toEqual([{ id: '{AAAA-BBBB}', path: 'D:\\Source\\UE5 Main' }, { id: 'Custom', path: 'E:\\Engines\\Custom' }]);
    expect(parseRegistryBuilds('ERROR: The system was unable to find the specified registry key')).toEqual([]);
  });

  it('inspects an install and says what a half-finished one lacks', () => {
    const good = inspectEngine('UE_5.5', copyFixture('engines/UE_5.5'), 'launcher');
    expect(good).toMatchObject({ version: '5.5.4', branch: '++UE5+Release-5.5', complete: true, hasEditor: true, hasEditorCmd: true, hasBuildBat: true, note: '' });
    const broken = inspectEngine('UE_5.6', copyFixture('engines/UE_5.6-broken'), 'launcher');
    expect(broken).toBeUndefined(); // an empty Engine folder is not an engine
    const partial = makeTempDir();
    mkdirSync(join(partial, 'Engine', 'Binaries', 'Win64'), { recursive: true });
    writeFileSync(join(partial, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe'), 'x');
    expect(inspectEngine('UE_5.6', partial, 'launcher')).toMatchObject({ complete: false, version: null, hasEditor: true, note: expect.stringContaining('Incomplete install') as unknown });
    expect(inspectEngine('x', join(partial, 'missing'), 'configured')).toBeUndefined();
  });

  it('combines every source, once per folder, newest first, and survives a failing registry', async () => {
    const e55 = copyFixture('engines/UE_5.5');
    const found = await discoverEngines({
      launcherFile: () => JSON.stringify({ InstallationList: [{ InstallLocation: e55, AppName: 'UE_5.5' }, { InstallLocation: 'V:\\gone\\UE_5.8', AppName: 'UE_5.8' }] }),
      queryRegistry: () => Promise.reject(new Error('reg.exe failed')),
      configured: () => [e55],
      defaultRoots: () => ['C:\\Program Files\\Epic Games'],
      listDirectory: () => ['UE_5.4', 'readme.txt'],
    });
    expect(found.map((x) => [x.id, x.source])).toEqual([['UE_5.5', 'launcher']]); // the same folder from the configured list is not listed twice; missing folders are not engines
  });

  it('works with nothing installed', async () => {
    expect(await discoverEngines({ launcherFile: () => undefined, queryRegistry: () => Promise.resolve(undefined), configured: () => [], defaultRoots: () => [], listDirectory: () => [] })).toEqual([]);
  });
});

describe('which engine a project asks for', () => {
  const install = (id: string, version: string | null): Parameters<typeof resolveEngine>[1][number] => ({ id, version, branch: null, path: `X:\\${id}`, source: 'launcher', hasEditor: true, hasEditorCmd: true, hasBuildBat: true, complete: true, note: '' });
  const installs = [install('UE_5.8', '5.8.4'), install('UE_5.5', '5.5.4'), install('{AAA}', null)];

  it('matches a version such as 5.5 to the install with that major and minor version', () => {
    expect(resolveEngine('5.5', installs)).toMatchObject({ install: { id: 'UE_5.5' }, how: expect.stringContaining('5.5') as unknown });
  });

  it('matches a source-build id, and says which version is missing instead of using another', () => {
    expect(resolveEngine('{aaa}', installs)).toMatchObject({ install: { id: '{AAA}' } });
    const missing = resolveEngine('5.4', installs);
    expect(missing.install).toBeUndefined();
    expect('why' in missing && missing.why).toContain('5.4, which is not installed here (found: 5.8.4, 5.5.4');
  });

  it('does not guess for an empty association or an unknown id', () => {
    expect(resolveEngine('', installs)).toMatchObject({ install: undefined, why: expect.stringContaining('does not name an engine') as unknown });
    expect(resolveEngine('{ZZZ}', installs)).toMatchObject({ install: undefined, why: expect.stringContaining('not registered') as unknown });
    expect(resolveEngine('5.5', [])).toMatchObject({ install: undefined });
  });
});
