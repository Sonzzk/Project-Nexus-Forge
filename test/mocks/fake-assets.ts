import type { AssetItem, AssetSearchResult, CheckReport, OpsPreview } from '../../src/shared/assets';
import type { MemoryPreview } from '../../src/shared/context';
import type { TrackedAsset } from '../../src/shared/blender';
import type { FakeApi } from './fake-api';

// Stand-in for the asset channels, so component tests can click through the Assets page. The real logic (scanning, search, checks,
// previews, moves) is tested in src/main/scanning.

export const sampleAsset = (overrides: Partial<AssetItem> = {}): AssetItem => ({ path: 'art/rock.png', category: 'texture', extension: 'png', bytes: 70, modifiedAt: '2026-10-24T08:00:00.000Z', previewable: true, annotation: null, ...overrides });

export const sampleChecks = (overrides: Partial<CheckReport> = {}): CheckReport => ({
  engine: 'godot',
  rule: 'Godot: snake_case (lowercase) file and folder names.',
  checked: 3,
  counts: { spaces: 1, characters: 0, case: 0, prefix: 0, 'duplicate-name': 0, depth: 0, 'loose-root': 0, 'mixed-case-folder': 0 },
  findings: [{ rule: 'spaces', path: 'art/My Rock.png', message: 'The name has spaces.', suggestion: 'art/my_rock.png' }],
  more: 0,
  note: 'Report only: nothing was renamed or moved.',
  ...overrides,
});

export interface FakeAssets {
  items: AssetItem[];
  scanned: boolean;
  checks: CheckReport;
  moved: { from: string; to: string }[];
  trashed: string[];
  /** Whether the next move or removal window is agreed to. */
  agree: boolean;
  saved: string[];
  stored: string;
}

export function attachAssets(fake: FakeApi, seed: Partial<FakeAssets> = {}): FakeAssets {
  const state: FakeAssets = { items: [sampleAsset(), sampleAsset({ path: 'art/crate.fbx', category: 'model', extension: 'fbx', previewable: false }), sampleAsset({ path: 'data/hero.uasset', category: 'engine', extension: 'uasset', previewable: false })], scanned: true, checks: sampleChecks(), moved: [], trashed: [], agree: true, saved: [], stored: '', ...seed };
  const summary = () => ({ scannedAt: '2026-10-24T09:00:00.000Z', entries: 40, files: state.items.length, added: state.items.length, changed: 0, removed: 0, unchanged: 0, truncated: false, durationMs: 120 });
  const counts = () => {
    const result: AssetSearchResult['counts'] = { model: 0, texture: 0, material: 0, audio: 0, animation: 0, scene: 0, script: 0, font: 0, video: 0, build: 0, engine: 0 };
    for (const i of state.items) result[i.category]++;
    return result;
  };
  fake.handlers['assets:search'] = (input) => {
    const r = input as { query: string; category: string | null; tag: string; annotatedOnly: boolean; limit: number; offset: number };
    const q = r.query.toLowerCase();
    const matches = state.items.filter((i) => (r.category === null || i.category === r.category) && (q === '' || i.path.toLowerCase().includes(q) || (i.annotation?.note ?? '').toLowerCase().includes(q)) && (r.tag === '' || (i.annotation?.tags ?? []).includes(r.tag)) && (!r.annotatedOnly || i.annotation !== null));
    return { items: matches.slice(r.offset, r.offset + r.limit), total: matches.length, counts: counts(), scan: state.scanned ? summary() : null } satisfies AssetSearchResult;
  };
  fake.handlers['assets:scan'] = () => {
    state.scanned = true;
    return summary();
  };
  fake.handlers['assets:tracked'] = () => state.items.filter((i) => i.annotation !== null).map((i): TrackedAsset => ({ id: i.annotation?.id ?? '', path: i.path, kind: 'other', note: i.annotation?.note ?? '', tags: i.annotation?.tags ?? [], trackedAt: '2026-10-24T09:00:00.000Z', status: 'unchanged' }));
  fake.handlers['assets:annotate'] = (input) => {
    const r = input as { relativePath: string; note: string; tags: string[]; source: string; usage: string; taskIds: string[] };
    state.items = state.items.map((i) => (i.path === r.relativePath ? { ...i, annotation: { id: `asset-${i.path}`, note: r.note, tags: r.tags, source: r.source, usage: r.usage, taskIds: r.taskIds, status: 'unchanged' } } : i));
    return state.items.find((i) => i.path === r.relativePath) ?? state.items[0] ?? sampleAsset();
  };
  fake.handlers['assets:checks'] = () => state.checks;
  fake.handlers['assets:register'] = () => ({ content: '# Asset register: Alpha\n\n## Important assets\n' });
  fake.handlers['memory:preview'] = (input) => {
    state.stored = (input as { content: string }).content;
    return { type: 'ASSET_REGISTER', location: 'App database', isNew: true, unchanged: false, createsFolder: false, diff: [{ kind: 'add', text: '# Asset register: Alpha' }], bytes: state.stored.length, previousBytes: 0 } satisfies MemoryPreview;
  };
  fake.handlers['memory:save'] = () => {
    state.saved.push(state.stored);
    return { written: true, location: 'App database' };
  };
  const plan = (kind: 'move' | 'trash', from: string, to: string | null): OpsPreview => ({ kind, items: [{ from, to, bytes: 70, tracked: false }], problems: to === 'art/crate.fbx' ? ['art/crate.fbx already exists; this app never overwrites a file.'] : [], warnings: ['References to these files inside scenes are not updated by this app.'], permitted: false });
  fake.handlers['assets:previewMove'] = (input) => {
    const m = (input as { moves: { from: string; to: string }[] }).moves[0];
    return plan('move', m?.from ?? '', m?.to ?? '');
  };
  fake.handlers['assets:move'] = (input) => {
    if (!state.agree) return { done: false, count: 0 };
    state.moved.push(...(input as { moves: { from: string; to: string }[] }).moves);
    return { done: true, count: 1 };
  };
  fake.handlers['assets:previewTrash'] = (input) => plan('trash', (input as { relativePaths: string[] }).relativePaths[0] ?? '', null);
  fake.handlers['assets:trash'] = (input) => {
    if (!state.agree) return { done: false, count: 0 };
    state.trashed.push(...(input as { relativePaths: string[] }).relativePaths);
    return { done: true, count: 1 };
  };
  return state;
}
