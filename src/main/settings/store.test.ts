import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '@shared/errors';
import { SETTING_KEYS, SettingsSchema } from '@shared/settings';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { removeTempDirs } from '../../../test/helpers/temp';
import { createActivityLog } from '../logging/activity';
import { createRedactor } from '../logging/redactor';
import { createSettingsStore } from './store';

afterEach(removeTempDirs);

async function setup() {
  const { db, dir } = await openMigratedDb();
  const logger = memoryLogger();
  const activity = createActivityLog({ db, redactor: createRedactor(), logger });
  return { db, dir, logger, activity, open: () => createSettingsStore({ db, logger, activity }) };
}

describe('settings schema', () => {
  it('has a default for every key', () => {
    expect(SettingsSchema.parse({})).toEqual({
      'logging.level': 'info',
      'ui.density': 'comfortable',
      'ui.sidebarCollapsed': false,
      'ui.inspectorOpen': false,
      'ui.layout': {},
      'projects.selectedId': null,
    });
  });

  it('has no secret fields: credentials never live in ordinary settings', () => {
    for (const key of SETTING_KEYS)
      expect(key).not.toMatch(/password|secret|token|api[-_.]?key|credential|auth/i);
  });
});

describe('createSettingsStore', () => {
  it('returns defaults on a fresh database', async () => {
    const { db, open } = await setup();
    expect(open().all()).toEqual(SettingsSchema.parse({}));
    db.close();
  });

  it('stores a valid value, notifies listeners and survives a restart', async () => {
    const { db, open } = await setup();
    const store = open();
    const changed: string[] = [];
    const stop = store.onChange((key) => changed.push(key));
    store.set('ui.density', 'compact');
    store.set('logging.level', 'debug');
    stop();
    store.set('logging.level', 'warn');
    expect(changed).toEqual(['ui.density', 'logging.level']);

    const reopened = open();
    expect(reopened.get('ui.density')).toBe('compact');
    expect(reopened.get('logging.level')).toBe('warn');
    db.close();
  });

  it('rejects an invalid value with INVALID_INPUT and keeps the old one', async () => {
    const { db, open } = await setup();
    const store = open();
    store.set('ui.density', 'compact');
    let error: unknown;
    try {
      store.set('ui.density', 'enormous');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INVALID_INPUT');
    expect((error as AppError).hint).toBeDefined();
    expect(open().get('ui.density')).toBe('compact');
    db.close();
  });

  it('falls back to the default for an invalid stored value, and warns in the log and the activity list', async () => {
    const { db, logger, activity, open } = await setup();
    db.run("INSERT INTO settings (key, value_json, updated_at) VALUES ('ui.density', '\"enormous\"', 'x')");
    db.run(
      "INSERT INTO settings (key, value_json, updated_at) VALUES ('logging.level', 'not json at all', 'x')",
    );
    db.run("INSERT INTO settings (key, value_json, updated_at) VALUES ('from.the.future', '1', 'x')");
    const store = open();
    expect(store.all()).toEqual(SettingsSchema.parse({}));
    expect(logger.entries.filter((e) => e.lvl === 'warn').map((e) => e.data?.['key'])).toEqual([
      'ui.density',
      'logging.level',
    ]);
    expect(activity.list({ limit: 10 }).filter((e) => e.kind === 'settings.invalid')).toHaveLength(2);
    // The bad rows are kept, and so is the key from a newer version.
    expect(db.all('SELECT key FROM settings')).toHaveLength(3);
    db.close();
  });

  it('a valid key is not affected by an invalid neighbour', async () => {
    const { db, open } = await setup();
    db.run("INSERT INTO settings (key, value_json, updated_at) VALUES ('ui.density', '\"compact\"', 'x')");
    db.run("INSERT INTO settings (key, value_json, updated_at) VALUES ('logging.level', '42', 'x')");
    const store = open();
    expect(store.get('ui.density')).toBe('compact');
    expect(store.get('logging.level')).toBe('info');
    db.close();
  });
});
