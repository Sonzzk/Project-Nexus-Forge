import type { ActivityEvent } from '../../src/shared/activity';
import type { Api } from '../../src/shared/api';
import type { IpcResult } from '../../src/shared/errors';
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
  /** Delivers an event to subscribers, as main would. */
  emit(event: EventName, payload: ActivityEvent): void;
}

export function createFakeApi(
  initial: { settings?: Partial<Settings>; events?: ActivityEvent[] } = {},
): FakeApi {
  const listeners = new Map<string, Set<(payload: ActivityEvent) => void>>();
  const fake: FakeApi = {
    calls: [],
    settings: { ...SettingsSchema.parse({}), ...initial.settings },
    events: initial.events ?? [],
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
