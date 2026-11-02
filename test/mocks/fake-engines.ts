import { BACKROOMS_DOMAINS, HORROR_CHECKLIST, type ProfileView } from '../../src/shared/backrooms';
import { SCOPE_TIERS } from '../../src/shared/tasks';
import type { BlenderRunDetail, BlenderView, Brief, BriefFields, TrackedAsset } from '../../src/shared/blender';
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
  attachBlender(fake); // the Blender section sits on the same page; tests that care re-attach it with a seed
  return state;
}

// ---- Blender and assets (Step 19) ----

export const sampleBlenderView = (overrides: Partial<BlenderView> = {}): BlenderView => ({
  installs: [{ folder: 'C:\\Blender\\Blender 5.1', version: '5.1.2', source: 'configured', note: '' }],
  configuredPaths: ['C:\\Blender\\Blender 5.1'],
  hasBlend: true,
  files: [
    { path: 'art/chair.blend', bytes: 2 * 1024 * 1024, modifiedAt: '2026-10-24T08:00:00.000Z', format: 'large-header', version: '5.1', backups: 1, tracked: false, newerThanInstalled: false },
    { path: 'art/room.blend', bytes: 80_000, modifiedAt: '2026-10-23T08:00:00.000Z', format: 'legacy', version: '6.0', backups: 0, tracked: false, newerThanInstalled: true },
  ],
  scripts: [{ path: 'tools/export.py', bytes: 120, hash: 'abcdef012345', approved: false, changed: false, approvalId: null }],
  runs: [],
  assets: [],
  capabilities: [
    { id: 'inspect', label: 'Describe a scene in a headless run on a copy', state: 'implemented', reason: '' },
    { id: 'live-bridge', label: 'Live control of a running Blender', state: 'unavailable', reason: 'Not built.' },
  ],
  truncated: false,
  checkedAt: '2026-10-24T08:00:00.000Z',
  ...overrides,
});

export interface FakeBlender {
  view: BlenderView;
  briefs: Brief[];
  opened: string[];
  /** What the next run answers. */
  outcome: BlenderRunDetail['outcome'];
  unchanged: boolean;
}

export function attachBlender(fake: FakeApi, seed: Partial<FakeBlender> = {}): FakeBlender {
  const state: FakeBlender = { view: sampleBlenderView(), briefs: [], opened: [], outcome: 'passed', unchanged: true, ...seed };
  let n = 0;
  const detail = (kind: 'inspect' | 'script', source: string, script: string | null): BlenderRunDetail => ({
    id: `run-${++n}`, kind, source, script, blenderVersion: '5.1.2', startedAt: '2026-10-24T09:00:00.000Z', endedAt: '2026-10-24T09:00:05.000Z', status: 'exited', exitCode: state.outcome === 'passed' ? 0 : 1, outcome: state.outcome, originalUnchanged: state.unchanged,
    errorSummary: state.outcome === 'passed' ? '' : "KeyError: 'Nope'", log: 'Blender 5.1.2\nBlender quit', truncated: false,
    outputs: kind === 'script' ? [{ path: 'out/report.txt', bytes: 40 }] : [],
    result: kind === 'inspect' ? { blender: '5.1.2', scenes: ['Scene'], objects: 3, objectTypes: { MESH: 1, LIGHT: 1, CAMERA: 1 }, meshes: 1, triangles: 12, materials: 1, images: 0, collections: 1, actions: 0, armatures: 0, libraries: [], missingFiles: [{ kind: 'image', name: 'a', path: '//tex/a.png' }], unitSystem: 'METRIC', unitScale: 1 } : null,
  });
  const record = (d: BlenderRunDetail): BlenderRunDetail => {
    const summary = { id: d.id, kind: d.kind, source: d.source, script: d.script, blenderVersion: d.blenderVersion, startedAt: d.startedAt, endedAt: d.endedAt, status: d.status, exitCode: d.exitCode, outcome: d.outcome, originalUnchanged: d.originalUnchanged, errorSummary: d.errorSummary };
    state.view = { ...state.view, runs: [summary, ...state.view.runs] };
    return d;
  };
  fake.handlers['blender:view'] = () => state.view;
  fake.handlers['blender:addPath'] = () => ({ added: false });
  fake.handlers['blender:removePath'] = () => ({ removed: true });
  fake.handlers['blender:open'] = (input) => (state.opened.push((input as { relativePath: string }).relativePath), { opened: true });
  fake.handlers['blender:inspect'] = (input) => record(detail('inspect', (input as { relativePath: string }).relativePath, null));
  fake.handlers['blender:runApproved'] = (input) => {
    const { scriptPath, relativePath } = input as { scriptPath: string; relativePath: string };
    return record(detail('script', relativePath, scriptPath));
  };
  fake.handlers['blender:approveScript'] = (input) => {
    const { scriptPath } = input as { scriptPath: string };
    state.view = { ...state.view, scripts: state.view.scripts.map((s) => (s.path === scriptPath ? { ...s, approved: true, changed: false, approvalId: 'approval-1' } : s)) };
    return { approved: true };
  };
  fake.handlers['blender:revokeScript'] = () => {
    state.view = { ...state.view, scripts: state.view.scripts.map((s) => ({ ...s, approved: false, approvalId: null })) };
    return { revoked: true };
  };
  fake.handlers['blender:run'] = (input) => {
    const found = state.view.runs.find((r) => r.id === (input as { id: string }).id);
    return found === undefined ? detail('inspect', 'x', null) : { ...detail(found.kind, found.source, found.script), id: found.id };
  };
  fake.handlers['blender:revealRun'] = () => ({ opened: true });
  fake.handlers['assets:track'] = (input) => {
    const { relativePath: path } = input as { relativePath: string };
    const asset: TrackedAsset = { id: `asset-${++n}`, path, kind: 'model', note: '', tags: [], trackedAt: '2026-10-24T09:00:00.000Z', status: 'unchanged' };
    state.view = { ...state.view, assets: [...state.view.assets, asset], files: state.view.files.map((f) => (f.path === path ? { ...f, tracked: true } : f)) };
    return asset;
  };
  fake.handlers['assets:untrack'] = (input) => {
    const id = (input as { id: string }).id;
    const gone = state.view.assets.find((a) => a.id === id);
    state.view = { ...state.view, assets: state.view.assets.filter((a) => a.id !== id), files: state.view.files.map((f) => (f.path === gone?.path ? { ...f, tracked: false } : f)) };
    return { removed: true };
  };
  fake.handlers['briefs:list'] = () => state.briefs;
  fake.handlers['briefs:save'] = (input) => {
    const { id, fields } = input as { id?: string; fields: BriefFields };
    const brief: Brief = { ...fields, id: id ?? `brief-${++n}`, createdAt: '2026-10-24T09:00:00.000Z', updatedAt: '2026-10-24T09:00:00.000Z' };
    state.briefs = id === undefined ? [...state.briefs, brief] : state.briefs.map((b) => (b.id === id ? brief : b));
    return brief;
  };
  fake.handlers['briefs:remove'] = (input) => {
    state.briefs = state.briefs.filter((b) => b.id !== (input as { id: string }).id);
    return { removed: true };
  };
  fake.handlers['briefs:handoff'] = (input) => {
    const brief = state.briefs.find((b) => b.id === (input as { id: string }).id);
    return { text: `# Import handoff: ${brief?.name ?? '?'}\n\nChecklist`, basedOnInspect: null };
  };
  return state;
}
