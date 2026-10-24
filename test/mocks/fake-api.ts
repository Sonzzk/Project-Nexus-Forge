import type { ActivityEvent } from '../../src/shared/activity';
import type { Api } from '../../src/shared/api';
import type { IpcResult } from '../../src/shared/errors';
import type { Project } from '../../src/shared/projects';
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
    emit: (event, payload) => listeners.get(event)?.forEach((listener) => listener(payload)),
    api: undefined as unknown as Api,
  };

  const invoke = ((channel: string, input: unknown): Promise<IpcResult<unknown>> => {
    fake.calls.push({ channel, input });
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
