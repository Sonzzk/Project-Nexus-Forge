import type { ActivityEvent } from '../../src/shared/activity';
import type { Api } from '../../src/shared/api';
import type { IpcResult } from '../../src/shared/errors';
import type { AuditReport, GitSummary } from '../../src/shared/audit';
import type { Project } from '../../src/shared/projects';
import type { ContextPack, Handoff, HandoffFields, MemoryOverview, MemoryPreview, PackSummary } from '../../src/shared/context';
import type { BackupItem, ExportResult, ImportPreview, ImportResult } from '../../src/shared/storage';
import type { EventName } from '../../src/shared/ipc/channels';
import { SETTING_KEYS, SettingsSchema, type Settings } from '../../src/shared/settings';

// The fake `window.api` for component tests. It lives only under test/ (ARCHITECTURE.md section 14): production code never
// imports it. It uses the real settings schema, so a test cannot store a value the app would refuse.

export interface FakeApi {
  api: Api;
  /** Every `invoke`, in order. */
  calls: { channel: string; input: unknown }[];
  settings: Settings;
  events: ActivityEvent[];
  projects: Project[];
  /** The stored audit that `audit:latest` answers with, and what the next `audit:run` produces. */
  report: AuditReport | null;
  nextReport: AuditReport;
  git: GitSummary;
  /** Project-relative paths the page asked to reveal. */
  revealed: string[];
  /** Extra channels answered by a helper (see fake-planning.ts); a handler returns the value of an ok result. */
  handlers: Record<string, (input: unknown) => unknown>;
  /** Project context: canned answers for the memory, pack and handoff channels. */
  memoryOverview: MemoryOverview;
  memoryContent: Record<string, string>;
  memoryPreview: MemoryPreview;
  packResult: ContextPack;
  packList: PackSummary[];
  handoffDraft: HandoffFields;
  handoffs: Handoff[];
  /** Data and backups: what `storage:status` lists, and what the dialogs in main would answer. */
  backups: BackupItem[];
  exportResult: ExportResult;
  importPreview: ImportPreview;
  importResult: ImportResult;
  /** What the native folder picker returns next: a project to add, or null for cancel. */
  nextPick: Project | null;
  /** Delivers an event to subscribers, as main would. */
  emit(event: EventName, payload: ActivityEvent): void;
}

export function createFakeApi(
  initial: { settings?: Partial<Settings>; events?: ActivityEvent[]; projects?: Project[] } = {},
): FakeApi {
  const listeners = new Map<string, Set<(payload: ActivityEvent) => void>>();
  const fake: FakeApi = {
    calls: [],
    settings: { ...SettingsSchema.parse({}), ...initial.settings },
    events: initial.events ?? [],
    projects: initial.projects ?? [],
    nextPick: null,
    report: null,
    nextReport: sampleReport(1),
    git: { available: true, isRepository: false, message: 'Not a Git repository.' },
    revealed: [],
    backups: [],
    handlers: {},
    memoryOverview: sampleMemoryOverview(),
    memoryContent: {},
    memoryPreview: { type: 'DECISIONS', location: 'App database', isNew: true, unchanged: false, createsFolder: false, diff: [{ kind: 'add', text: '# Decisions' }], bytes: 12, previousBytes: 0 },
    packResult: samplePack(),
    packList: [],
    handoffDraft: { requested: '', changed: 'Branch main. Uncommitted: 0 staged, 2 modified, 0 untracked.', verified: '', unfinished: 'TODO: add jump (scripts/player.gd:5)', risks: '', files: '', nextTask: '' },
    handoffs: [],
    exportResult: { saved: true, tables: [{ id: 'projects', label: 'Projects', rows: 2 }] },
    importPreview: { staged: false, tables: [], projectFolders: [], warnings: [] },
    importResult: { applied: true, tables: [] },
    emit: (event, payload) => listeners.get(event)?.forEach((listener) => listener(payload)),
    api: undefined as unknown as Api,
  };

  const invoke = ((channel: string, input: unknown): Promise<IpcResult<unknown>> => {
    fake.calls.push({ channel, input });
    const handler = fake.handlers[channel];
    if (handler !== undefined) {
      try {
        return Promise.resolve({ ok: true, value: handler(input) });
      } catch (error) {
        const e = error as { code?: string; message?: string; hint?: string };
        return Promise.resolve({ ok: false, error: { code: (e.code ?? 'INTERNAL') as 'INTERNAL', message: e.message ?? 'Failed.', ...(e.hint === undefined ? {} : { hint: e.hint }), retryable: false } });
      }
    }
    if (channel === 'settings:get') return Promise.resolve({ ok: true, value: fake.settings });
    if (channel === 'settings:set') {
      const { key, value } = input as { key: string; value: unknown };
      const settingKey = SETTING_KEYS.find((k) => k === key);
      const parsed = settingKey === undefined ? undefined : SettingsSchema.shape[settingKey].safeParse(value);
      if (settingKey === undefined || !parsed?.success)
        return Promise.resolve({
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'Not a valid value.',
            hint: 'Try again.',
            retryable: false,
          },
        });
      fake.settings = { ...fake.settings, [settingKey]: parsed.data };
      return Promise.resolve({ ok: true, value: fake.settings });
    }
    if (channel === 'app:getInfo')
      return Promise.resolve({
        ok: true,
        value: {
          name: 'gdcc',
          version: '0.1.0',
          platform: 'win32',
          electronVersion: '45',
          nodeVersion: '24',
          schemaVersion: 1,
          dataDir: '~\\data',
          logFile: '~\\main.log',
        },
      });
    if (channel === 'projects:list') return Promise.resolve({ ok: true, value: fake.projects });
    if (channel === 'projects:pickAndAdd') {
      const picked = fake.nextPick;
      if (picked !== null) fake.projects = [...fake.projects, picked];
      fake.nextPick = null;
      return Promise.resolve({ ok: true, value: { project: picked } });
    }
    if (channel === 'projects:update') {
      const patch = input as {
        id: string;
        name?: string;
        status?: Project['status'];
        typeOverride?: Project['type'] | null;
        tags?: string[];
        description?: string;
        instructions?: string;
      };
      const found = fake.projects.find((p) => p.id === patch.id);
      if (found === undefined)
        return Promise.resolve({
          ok: false,
          error: {
            code: 'NOT_FOUND',
            message: 'That project is not in the registry.',
            hint: 'Reload.',
            retryable: false,
          },
        });
      const next: Project = {
        ...found,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.tags === undefined ? {} : { tags: patch.tags }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.instructions === undefined ? {} : { instructions: patch.instructions }),
        ...(typeof patch.typeOverride === 'string'
          ? { type: patch.typeOverride, typeSource: 'manual' as const }
          : {}),
      };
      fake.projects = fake.projects.map((p) => (p.id === next.id ? next : p));
      return Promise.resolve({ ok: true, value: next });
    }
    if (channel === 'projects:remove') {
      fake.projects = fake.projects.filter((p) => p.id !== (input as { id: string }).id);
      return Promise.resolve({ ok: true, value: { removed: true } });
    }
    if (channel === 'memory:overview') return Promise.resolve({ ok: true, value: fake.memoryOverview });
    if (channel === 'memory:read') {
      const { docType } = input as { docType: string };
      const content = fake.memoryContent[docType];
      return Promise.resolve({ ok: true, value: { content: content ?? '', location: 'App database', exists: content !== undefined } });
    }
    if (channel === 'memory:preview') return Promise.resolve({ ok: true, value: fake.memoryPreview });
    if (channel === 'memory:save') return Promise.resolve({ ok: true, value: { written: true, location: 'App database' } });
    if (channel === 'memory:setStorage') {
      const { storage, docsDir } = input as { storage: MemoryOverview['storage']; docsDir: string };
      fake.memoryOverview = { ...fake.memoryOverview, storage, docsDir };
      return Promise.resolve({ ok: true, value: fake.memoryOverview });
    }
    if (channel === 'packs:build') {
      const { task, budget, destination } = input as { task: string; budget: number; destination: string };
      fake.packResult = { ...fake.packResult, task, budget, destination, saved: false, id: '' };
      return Promise.resolve({ ok: true, value: fake.packResult });
    }
    if (channel === 'packs:save') {
      const { title } = input as { title: string };
      fake.packResult = { ...fake.packResult, id: 'pack-1', title, saved: true };
      fake.packList = [{ id: 'pack-1', title, destination: fake.packResult.destination, estimate: fake.packResult.estimate, files: fake.packResult.items.length, createdAt: fake.packResult.createdAt, stale: 0 }];
      return Promise.resolve({ ok: true, value: fake.packResult });
    }
    if (channel === 'packs:list') return Promise.resolve({ ok: true, value: fake.packList });
    if (channel === 'packs:get' || channel === 'packs:refresh') return Promise.resolve({ ok: true, value: fake.packResult });
    if (channel === 'packs:remove') {
      fake.packList = [];
      return Promise.resolve({ ok: true, value: { removed: true } });
    }
    if (channel === 'handoffs:draft') return Promise.resolve({ ok: true, value: fake.handoffDraft });
    if (channel === 'handoffs:save') {
      const saved: Handoff = { ...(input as { fields: HandoffFields }).fields, id: `handoff-${fake.handoffs.length + 1}`, projectId: (input as { projectId: string }).projectId, createdAt: '2026-10-24T05:00:00.000Z' };
      fake.handoffs = [saved, ...fake.handoffs];
      return Promise.resolve({ ok: true, value: saved });
    }
    if (channel === 'handoffs:list') return Promise.resolve({ ok: true, value: fake.handoffs });
    if (channel === 'handoffs:latest') return Promise.resolve({ ok: true, value: fake.handoffs[0] ?? null });
    if (channel === 'storage:status')
      return Promise.resolve({ ok: true, value: { schemaVersion: 3, databaseBytes: 204800, backups: fake.backups, lastScheduledAt: null } });
    if (channel === 'storage:backupNow') {
      const made: BackupItem = { id: `gdcc-20261024T0${fake.backups.length}0000000Z-manual.db`, createdAt: '2026-10-24T03:00:00.000Z', reason: 'manual', sizeBytes: 90000 };
      fake.backups = [made, ...fake.backups];
      return Promise.resolve({ ok: true, value: made });
    }
    if (channel === 'storage:restore') return Promise.resolve({ ok: true, value: { staged: true } });
    if (channel === 'storage:exportData') return Promise.resolve({ ok: true, value: fake.exportResult });
    if (channel === 'storage:previewImport') return Promise.resolve({ ok: true, value: fake.importPreview });
    if (channel === 'storage:applyImport') return Promise.resolve({ ok: true, value: fake.importResult });
    if (channel === 'audit:latest') return Promise.resolve({ ok: true, value: fake.report });
    if (channel === 'audit:list')
      return Promise.resolve({
        ok: true,
        value: fake.report ? [{ id: fake.report.id, projectId: fake.report.projectId, finishedAt: fake.report.finishedAt, files: fake.report.scan.files }] : [],
      });
    if (channel === 'audit:run') {
      fake.report = fake.nextReport;
      return Promise.resolve({ ok: true, value: fake.report });
    }
    if (channel === 'audit:reveal') {
      fake.revealed.push((input as { relativePath: string }).relativePath);
      return Promise.resolve({ ok: true, value: { revealed: true } });
    }
    if (channel === 'git:summary') return Promise.resolve({ ok: true, value: fake.git });
    if (channel === 'activity:list') return Promise.resolve({ ok: true, value: fake.events });
    return Promise.resolve({
      ok: false,
      error: { code: 'NOT_FOUND', message: `No fake for ${channel}.`, retryable: false },
    });
  }) as Api['invoke'];

  const on = ((event: string, listener: (payload: ActivityEvent) => void) => {
    const set = listeners.get(event) ?? new Set();
    set.add(listener);
    listeners.set(event, set);
    return () => set.delete(listener);
  }) as Api['on'];

  fake.api = { invoke, on };
  return fake;
}

export const sampleEvent = (n: number, overrides: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: `event-${n}`,
  occurredAt: `2026-10-24T01:00:0${n}.000Z`,
  kind: 'test.event',
  severity: 'info',
  summary: `Event number ${n}`,
  ...overrides,
});

export const sampleProject = (n: number, overrides: Partial<Project> = {}): Project => ({
  id: `project-${n}`,
  name: `Game ${n}`,
  description: '',
  type: 'godot',
  typeSource: 'detected',
  engine: 'Godot',
  engineVersion: '4.3',
  rootPath: `D:\\Games\\Game${n}`,
  status: 'active',
  folderExists: true,
  tags: [],
  instructions: '',
  aiPrefs: {},
  backupPrefs: {},
  detection: {
    type: 'godot',
    engine: 'Godot',
    engineVersion: '4.3',
    confidence: 'confirmed',
    evidence: [{ path: 'project.godot', detail: 'Godot project file, engine 4.3' }],
  },
  createdAt: '2026-10-24T01:00:00.000Z',
  updatedAt: '2026-10-24T01:00:00.000Z',
  ...overrides,
});

export const sampleReport = (n: number, overrides: Partial<AuditReport> = {}): AuditReport => ({
  id: `audit-${n}`,
  projectId: 'project-1',
  startedAt: '2026-10-24T02:00:00.000Z',
  finishedAt: '2026-10-24T02:00:01.000Z',
  scan: {
    files: 12,
    directories: 3,
    bytes: 2048,
    skippedHeavyDirs: [],
    sensitiveFilesSkipped: 0,
    linksSkipped: 0,
    truncated: [],
    elapsedMs: 40,
  },
  git: { available: true, isRepository: false, message: 'Not a Git repository.' },
  sections: [
    {
      id: 'overview',
      title: 'Overview',
      summary: '1 fact about the folder.',
      findings: [{ kind: 'confirmed', title: '12 files in 3 folders', evidence: [{ path: '.', detail: 'Counted by the scanner' }] }],
    },
    {
      id: 'engine',
      title: 'Engine and version',
      summary: 'Godot project, engine 4.3',
      findings: [
        { kind: 'confirmed', title: 'Godot project, engine 4.3', evidence: [{ path: 'project.godot', detail: 'Godot project file' }] },
        { kind: 'inferred', title: 'src/main.gd looks like an entry point', evidence: [{ path: 'src/main.gd' }] },
      ],
    },
  ],
  ...overrides,
});

export function sampleMemoryOverview(): MemoryOverview {
  return {
    storage: 'app',
    docsDir: '',
    docs: (['PROJECT_CONTEXT', 'GAME_DESIGN', 'ARCHITECTURE', 'ROADMAP', 'TASKS', 'DECISIONS', 'SESSION_HANDOFF', 'TEST_PLAN', 'ASSET_REGISTER', 'CHANGELOG'] as const).map((type) => ({
      type,
      location: 'App database',
      exists: false,
      bytes: 0,
    })),
    proposal: [
      { type: 'PROJECT_CONTEXT', reason: 'The project has no documentation of this kind yet.' },
      { type: 'DECISIONS', reason: 'The project has no documentation of this kind yet.' },
    ],
  };
}

export function samplePack(): ContextPack {
  return {
    id: '',
    projectId: 'project-1',
    title: 'Make the player faster',
    task: 'Make the player faster',
    budget: 8000,
    estimate: 420,
    destination: 'Not sent anywhere yet',
    items: [
      { path: 'scripts/player.gd', kind: 'file', reason: 'file name mentions "player"', bytes: 180, estimate: 60, mtimeMs: 1, sha256: 'a'.repeat(64) },
      { path: 'scripts/util.gd', kind: 'file', reason: 'contains "speed"', bytes: 120, estimate: 40, mtimeMs: 1, sha256: 'b'.repeat(64) },
    ],
    excluded: [{ path: 'logo.png', reason: 'binary or unknown file type; never included' }],
    text: '# Context pack\n\n## File: scripts/player.gd\n',
    createdAt: '2026-10-24T04:00:00.000Z',
    stale: [],
    saved: false,
  };
}
