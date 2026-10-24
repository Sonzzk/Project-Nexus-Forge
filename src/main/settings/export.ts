import { z } from 'zod';
import { SETTING_KEYS, SettingsSchema } from '@shared/settings';
import type { ExportableTable, Row } from '../storage';

// Settings join export and import (spec §22). Every value must fit its key's schema, exactly as `settings:set` requires.

export const settingsTable: ExportableTable = {
  id: 'settings',
  label: 'Settings',
  schema: z.strictObject({
    key: z.string().min(1).max(100),
    value_json: z.string().max(100_000),
    updated_at: z.iso.datetime(),
  }),
  key: ['key'],
  check(row: Row) {
    const key = SETTING_KEYS.find((candidate) => candidate === row['key']);
    if (key === undefined) return `"${String(row['key']).slice(0, 60)}" is not a known setting`;
    try {
      const parsed = SettingsSchema.shape[key].safeParse(JSON.parse(String(row['value_json'])));
      return parsed.success ? undefined : `the value for ${key} is not valid`;
    } catch {
      return `the value for ${key} is not valid JSON`;
    }
  },
};
