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
  /** Panel sizes in percent, by panel id (react-resizable-panels). */
  'ui.layout': z.record(z.string().max(40), z.number().min(0).max(100)).default({}),
});

export type Settings = z.output<typeof SettingsSchema>;
export type SettingKey = keyof Settings;
export const SETTING_KEYS = Object.keys(SettingsSchema.shape) as [SettingKey, ...SettingKey[]];
