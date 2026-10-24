import { z } from 'zod';

// One schema with a default for every key (ARCHITECTURE.md section 8, "Settings"). Each feature step adds its keys here;
// keys are only ever added. There are no secret fields: credentials never live in ordinary settings (spec §14).

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const SettingsSchema = z.object({
  'logging.level': z.enum(LOG_LEVELS).default('info'),
  'ui.density': z.enum(['comfortable', 'compact']).default('comfortable'),
  'ui.sidebarCollapsed': z.boolean().default(false),
  'ui.inspectorOpen': z.boolean().default(false),
  /** The project the top bar and the pages are showing, or null. */
  'projects.selectedId': z.string().max(64).nullable().default(null),
  /** Audit limits (spec §7): the scanner stops at either and the report says so. */
  'audit.maxFiles': z.number().int().min(1000).max(200_000).default(20_000),
  'audit.timeBudgetSeconds': z.number().int().min(1).max(120).default(8),
  /** Backups of the app database (spec §22). Project content is never backed up. */
  'backup.scheduleEnabled': z.boolean().default(false),
  'backup.intervalHours': z.number().int().min(1).max(720).default(24),
  /** How many backups to keep for each reason (manual, scheduled, before migration, before restore, before import). */
  'backup.keepCount': z.number().int().min(1).max(100).default(10),
  /** Panel sizes in percent, by panel id (react-resizable-panels). */
  'ui.layout': z.record(z.string().max(40), z.number().min(0).max(100)).default({}),
});

export type Settings = z.output<typeof SettingsSchema>;
export type SettingKey = keyof Settings;
export const SETTING_KEYS = Object.keys(SettingsSchema.shape) as [SettingKey, ...SettingKey[]];
