import { z } from 'zod';
import { ActivityEventSchema } from '../activity';
import { ProjectPatchSchema, ProjectSchema } from '../projects';
import { SETTING_KEYS, SettingsSchema } from '../settings';
import type { ChannelName } from './channels';

// One request schema and one response schema per channel. Main parses every request before a handler runs and every
// response before it is sent. Requests never carry absolute paths, executables, command arguments, shell strings or
// working directories (ARCHITECTURE.md section 6); a contract test enforces that by field name.

const noInput = z.strictObject({});

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.string(),
  electronVersion: z.string(),
  nodeVersion: z.string(),
  schemaVersion: z.number().int().nonnegative(),
  /** Shown with the home folder as `~`. */
  dataDir: z.string(),
  logFile: z.string(),
});
export type AppInfo = z.output<typeof AppInfoSchema>;

export const contract = {
  'app:getInfo': { request: noInput, response: AppInfoSchema },
  'app:reportRendererError': {
    request: z.strictObject({
      kind: z.enum(['error', 'unhandledrejection']),
      message: z.string().max(2000),
      stack: z.string().max(8000).optional(),
      source: z.string().max(500).optional(),
    }),
    response: z.strictObject({ accepted: z.boolean() }),
  },
  'settings:get': { request: noInput, response: SettingsSchema },
  'settings:set': {
    request: z.strictObject({ key: z.enum(SETTING_KEYS), value: z.unknown() }),
    response: SettingsSchema,
  },
  'activity:list': {
    request: z.strictObject({
      projectId: z.string().max(64).optional(),
      kinds: z.array(z.string().min(1).max(100)).max(20).optional(),
      before: z.iso.datetime().optional(),
      limit: z.number().int().min(1).max(500).default(50),
    }),
    response: z.array(ActivityEventSchema),
  },
  'projects:list': { request: noInput, response: z.array(ProjectSchema) },
  // The folder is chosen in a native dialog opened by main; the request carries no path. null means the user cancelled.
  'projects:pickAndAdd': {
    request: noInput,
    response: z.strictObject({ project: ProjectSchema.nullable() }),
  },
  'projects:update': { request: ProjectPatchSchema, response: ProjectSchema },
  'projects:redetect': { request: z.strictObject({ id: z.string().max(64) }), response: ProjectSchema },
  'projects:remove': {
    request: z.strictObject({ id: z.string().max(64) }),
    response: z.strictObject({ removed: z.literal(true) }),
  },
} satisfies Record<ChannelName, { request: z.ZodType; response: z.ZodType }>;

/** What the renderer sends. */
export type RequestOf<C extends ChannelName> = z.input<(typeof contract)[C]['request']>;
/** What the handler receives, after defaults are applied. */
export type ParsedRequestOf<C extends ChannelName> = z.output<(typeof contract)[C]['request']>;
export type ResponseOf<C extends ChannelName> = z.output<(typeof contract)[C]['response']>;
