import { AppError } from '@shared/errors';
import { SETTING_KEYS, SettingsSchema, type SettingKey, type Settings } from '@shared/settings';
import type { ActivityLog } from '../logging';
import type { Logger } from '../logging';
import type { Db } from '../storage';

// One Zod schema with a default for every key, stored one row per key (ARCHITECTURE.md section 8, "Settings").
// A stored value that fails validation falls back to its default, with a warning in the log and the activity list.

export interface SettingsStore {
  get<K extends SettingKey>(key: K): Settings[K];
  /** Validates `value` against the key's schema; throws INVALID_INPUT when it does not fit. */
  set(key: SettingKey, value: unknown): void;
  all(): Settings;
  onChange(listener: (key: SettingKey) => void): () => void;
}

export interface SettingsStoreOptions {
  db: Db;
  logger: Logger;
  activity?: ActivityLog;
  now?: () => Date;
}

interface Row {
  key: string;
  value_json: string;
}

export function createSettingsStore(options: SettingsStoreOptions): SettingsStore {
  const { db, logger, activity } = options;
  const now = options.now ?? (() => new Date());
  const listeners = new Set<(key: SettingKey) => void>();
  const values: Settings = SettingsSchema.parse({});

  const assign = <K extends SettingKey>(key: K, value: Settings[K]): void => {
    values[key] = value;
  };

  // Load: an unreadable or invalid stored value falls back to the default. The bad row is kept until the user sets the key again.
  for (const row of db.all<Row>('SELECT key, value_json FROM settings')) {
    const key = SETTING_KEYS.find((k) => k === row.key);
    if (key === undefined) continue; // written by a newer version of the app; keep it and ignore it
    let parsed: { success: true; data: unknown } | { success: false } = { success: false };
    try {
      // Not safeParse(undefined): a default would make unreadable JSON look valid.
      parsed = SettingsSchema.shape[key].safeParse(JSON.parse(row.value_json));
    } catch {
      // Unreadable JSON is invalid, same as a wrong value.
    }
    if (parsed.success) {
      assign(key, parsed.data as never);
    } else {
      logger.warn('stored setting is invalid; using the default', {
        key,
        stored: row.value_json.slice(0, 200),
      });
      activity?.record({
        kind: 'settings.invalid',
        severity: 'warning',
        summary: `The saved value for "${key}" was not valid, so the default is used.`,
        details: { key },
      });
    }
  }

  return {
    get: (key) => values[key],
    all: () => ({ ...values }),
    set(key, value) {
      const parsed = SettingsSchema.shape[key].safeParse(value);
      if (!parsed.success)
        throw new AppError(
          'INVALID_INPUT',
          `"${value === undefined ? 'undefined' : JSON.stringify(value)}" is not a valid value for ${key}.`,
          {
            hint: 'Choose one of the values the setting offers.',
            details: { key, issues: parsed.error.issues.map((issue) => issue.message) },
          },
        );
      db.run(
        'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
        key,
        JSON.stringify(parsed.data),
        now().toISOString(),
      );
      assign(key, parsed.data as never);
      for (const listener of listeners) {
        try {
          listener(key);
        } catch (error) {
          logger.warn('settings listener failed', { key, error });
        }
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
