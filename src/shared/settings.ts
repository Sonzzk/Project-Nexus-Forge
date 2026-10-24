import { z } from 'zod';
import { AGENT_ROLE_IDS } from './agents';
import { MODEL_NAME } from './providers';
import { INFERENCE_MODES } from './resources';
import { ROUTING_PROFILES, RoleOverrideSchema } from './routing';

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
  /** AI providers (spec §9). The Ollama address is loopback unless remote use is allowed on purpose. */
  'providers.ollamaEndpoint': z.string().min(1).max(200).default('http://127.0.0.1:11434'),
  'providers.ollamaAllowRemote': z.boolean().default(false),
  /** Longest wait for a provider answer, in seconds. */
  'providers.timeoutSeconds': z.number().int().min(10).max(3600).default(300),
  /** Context length asked of Ollama for each request; 0 keeps each model's own default. */
  'providers.ollamaContextLength': z.number().int().min(0).max(1_048_576).default(0),
  /** Routing (spec §12): the profile, the local model it may use, explicit choices per role, and how often a run may be tried. */
  'routing.profile': z.enum(ROUTING_PROFILES).default('balanced'),
  'routing.localModel': z.string().regex(MODEL_NAME).or(z.literal('')).default(''),
  'routing.roleOverrides': z.partialRecord(z.enum(AGENT_ROLE_IDS), RoleOverrideSchema).default({}),
  'routing.maxAttempts': z.number().int().min(1).max(5).default(3),
  /** Local inference (spec §13): the mode, the free memory a local model needs before it starts, and how idle models are released. */
  'inference.mode': z.enum(INFERENCE_MODES).default('allow-local'),
  'inference.minFreeVramMiB': z.number().int().min(0).max(98_304).default(6144),
  'inference.minFreeRamMiB': z.number().int().min(0).max(1_048_576).default(8192),
  'inference.holdForHeavyApps': z.boolean().default(true),
  /** How long Ollama keeps a model loaded after a request (its documented keep_alive); 0 unloads it right away. */
  'inference.keepAliveMinutes': z.number().int().min(0).max(120).default(5),
  /** How often held local runs look at the resources again. Nothing is measured while nothing waits. */
  'inference.monitorIntervalSeconds': z.number().int().min(5).max(600).default(30),
  /** Launch limits (spec §12): cloud launches the app may start. 0 turns a limit off. The app cannot see a provider's own quota, so these are a safeguard. */
  'limits.cloudPerDay': z.number().int().min(0).max(1000).default(20),
  'limits.cloudPerProjectPerDay': z.number().int().min(0).max(1000).default(10),
  'limits.cloudPerTask': z.number().int().min(0).max(1000).default(5),
  /** Context packs (spec §7): the token budget the builder starts from. An estimate; providers count differently. */
  'context.defaultBudget': z.number().int().min(500).max(200_000).default(8000),
  /** Tasks (spec §10): ask for an approved plan before a task moves to In progress, and which view the Tasks page opens in. */
  'tasks.requirePlanApproval': z.boolean().default(false),
  'tasks.view': z.enum(['board', 'list', 'roadmap']).default('board'),
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
