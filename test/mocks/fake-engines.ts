import { BACKROOMS_DOMAINS, HORROR_CHECKLIST, type ProfileView } from '../../src/shared/backrooms';
import { SCOPE_TIERS } from '../../src/shared/tasks';
import type { EngineInstall, UnrealProject, UnrealView } from '../../src/shared/unreal';
import type { FakeApi } from './fake-api';

// Stand-in for the engine and profile channels, so component tests can click through the Engines panel. The real logic (parsing a
// .uproject, discovering engines, the profile rules) is tested in src/main/engines.

export const sampleEngine = (overrides: Partial<EngineInstall> = {}): EngineInstall => ({
  id: 'UE_5.5',
  version: '5.5.4',
  branch: '++UE5+Release-5.5',
  path: 'C:\\Engines\\UE_5.5',
  source: 'launcher',
  hasEditor: true,
  hasEditorCmd: true,
  hasBuildBat: true,
  complete: true,
  note: '',
  ...overrides,
});

export const sampleUnrealProject = (overrides: Partial<UnrealProject> = {}): UnrealProject => ({
  uproject: 'Backrooms.uproject',
  name: 'Backrooms',
  fileVersion: 3,
  engineAssociation: '5.5',
  description: '',
  category: '',
  modules: [{ name: 'Hall', type: 'Runtime', loadingPhase: 'Default' }],
  plugins: [{ name: 'Flicker', enabled: true }, { name: 'OnlineSubsystem', enabled: false }],
  projectPlugins: ['Flicker'],
  targets: [{ name: 'Backrooms', type: 'Game', file: 'Source/Backrooms.Target.cs' }, { name: 'BackroomsEditor', type: 'Editor', file: 'Source/BackroomsEditor.Target.cs' }],
  buildCsFiles: 1,
  folders: { source: true, config: true, content: true, plugins: true, binaries: false, intermediate: false, saved: false, derivedDataCache: false },
  configFiles: ['DefaultEngine.ini', 'DefaultGame.ini'],
  defaultMap: '/Game/Maps/Hall',
  editorStartupMap: null,
  projectVersion: '0.1.0',
  content: { assets: 12, bytes: 3 * 1024 * 1024, maps: ['/Game/Maps/Hall'], topFolders: [{ name: 'Maps', assets: 2 }, { name: 'Props', assets: 10 }], truncated: false },
  hasSource: true,
  notes: [],
  ...overrides,
});

export const sampleUnrealView = (overrides: Partial<UnrealView> = {}): UnrealView => {
  const engine = sampleEngine();
  return {
    isUnreal: true,
    project: sampleUnrealProject(),
    engines: [engine, sampleEngine({ id: 'UE_5.6', version: null, branch: null, path: 'C:\\Engines\\UE_5.6', hasEditor: false, hasEditorCmd: false, complete: false, note: 'Incomplete install: the version file is missing.' })],
    configuredPaths: [],
    resolved: { id: engine.id, path: engine.path, how: 'the launcher entry for 5.5' },
    resolveNote: '',
    capabilities: [
      { id: 'build', label: 'Build the game', state: 'implemented', reason: 'Build.bat of UE_5.5 is present.' },
      { id: 'automation', label: 'Run automation tests', state: 'unavailable', reason: 'Not built in this version.' },
    ],
    commands: [{ label: 'Build Backrooms (Win64 Development)', writes: true }],
    checkedAt: '2026-10-24T08:00:00.000Z',
    ...overrides,
  };
};

export interface FakeEngines {
  view: UnrealView;
  profile: { enabled: boolean; confirmed: string[]; checked: string[] };
  history: { id: string; label: string; startedAt: string; endedAt: string | null; status: string; exitCode: number | null }[];
  logs: Record<string, string>;
  /** Whether the next "add a folder" dialog is confirmed. */
  pick: string | null;
  opened: string[];
}

export function attachEngines(fake: FakeApi, seed: Partial<FakeEngines> = {}): FakeEngines {
  const state: FakeEngines = { view: sampleUnrealView(), profile: { enabled: false, confirmed: [], checked: [] }, history: [], logs: {}, pick: null, opened: [], ...seed };
  const profileView = (): ProfileView => {
    const on = state.profile.enabled;
    const flags: ProfileView['flags'] = state.profile.confirmed.includes('multiplayer')
      ? [{ id: 'multiplayer', title: 'Multiplayer and networking is in scope', detail: 'Networking multiplies design, testing and bug-fixing work.' }]
      : [];
    return {
      enabled: on,
      domains: BACKROOMS_DOMAINS.map((d) => ({ id: d.id, label: d.label, confirmed: state.profile.confirmed.includes(d.id), hints: on && d.id === 'level' ? ['Map /Game/Maps/Hall'] : [] })),
      checklist: HORROR_CHECKLIST.map((c) => ({ id: c.id, label: c.label, question: c.question, checked: state.profile.checked.includes(c.id) })),
      flags: on ? flags : [],
      tiers: SCOPE_TIERS.map((tier) => ({ tier, milestones: 0 })),
      note: on ? '' : 'The profile is off. Turning it on changes nothing in the project.',
    };
  };
  fake.handlers['engines:view'] = () => state.view;
  fake.handlers['engines:open'] = (input) => {
    state.opened.push((input as { target: string }).target);
    return { opened: true };
  };
  fake.handlers['engines:addPath'] = () => {
    if (state.pick === null) return { added: false };
    state.view = { ...state.view, configuredPaths: [...state.view.configuredPaths, state.pick], engines: [...state.view.engines, sampleEngine({ id: 'MyEngine', path: state.pick, source: 'configured' })] };
    state.pick = null;
    return { added: true };
  };
  fake.handlers['engines:removePath'] = (input) => {
    const { index } = input as { index: number };
    const path = state.view.configuredPaths[index];
    state.view = { ...state.view, configuredPaths: state.view.configuredPaths.filter((_, i) => i !== index), engines: state.view.engines.filter((e) => e.path !== path) };
    return { removed: true };
  };
  fake.handlers['commands:history'] = () => state.history;
  fake.handlers['commands:log'] = (input) => {
    const found = state.history.find((h) => h.id === (input as { id: string }).id);
    if (found === undefined) throw Object.assign(new Error('That log does not exist.'), { code: 'NOT_FOUND' });
    return { ...found, output: state.logs[found.id] ?? '', truncated: false };
  };
  fake.handlers['profiles:get'] = profileView;
  fake.handlers['profiles:set'] = (input) => {
    const patch = input as { enabled?: boolean; confirmedDomains?: string[]; checked?: string[] };
    if (patch.enabled !== undefined) state.profile.enabled = patch.enabled;
    if (patch.confirmedDomains !== undefined) state.profile.confirmed = patch.confirmedDomains;
    if (patch.checked !== undefined) state.profile.checked = patch.checked;
    return profileView();
  };
  return state;
}
