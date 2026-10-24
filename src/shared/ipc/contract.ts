import { z } from 'zod';
import { ActivityEventSchema } from '../activity';
import {
  ContextPackSchema,
  DOC_TYPES,
  HandoffFieldsSchema,
  HandoffSchema,
  MAX_DOC_BYTES,
  MEMORY_STORAGES,
  MemoryApplyResultSchema,
  MemoryOverviewSchema,
  MemoryPreviewSchema,
  PackRequestSchema,
  PackSummarySchema,
} from '../context';
import { AuditReportSchema, AuditSummarySchema, GitSummarySchema } from '../audit';
import { ProjectPatchSchema, ProjectSchema } from '../projects';
import { SETTING_KEYS, SettingsSchema } from '../settings';
import {
  BackupItemSchema,
  ExportResultSchema,
  IMPORT_CONFLICT_MODES,
  ImportPreviewSchema,
  ImportResultSchema,
  StorageStatusSchema,
} from '../storage';
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
  // Audits are read-only. The folder comes from the registry; the page only names a project and, to reveal a file, a
  // project-relative path that main resolves inside the project root.
  'audit:run': { request: z.strictObject({ projectId: z.string().max(64) }), response: AuditReportSchema },
  'audit:latest': { request: z.strictObject({ projectId: z.string().max(64) }), response: AuditReportSchema.nullable() },
  'audit:list': { request: z.strictObject({ projectId: z.string().max(64) }), response: z.array(AuditSummarySchema) },
  'audit:get': {
    request: z.strictObject({ projectId: z.string().max(64), auditId: z.string().max(64) }),
    response: AuditReportSchema,
  },
  'audit:reveal': {
    request: z.strictObject({ projectId: z.string().max(64), relativePath: z.string().min(1).max(400) }),
    response: z.strictObject({ revealed: z.literal(true) }),
  },
  'git:summary': { request: z.strictObject({ projectId: z.string().max(64) }), response: GitSummarySchema },
  // Project memory, context packs and handoffs. Documents are named by type, files by project-relative path; writing into a
  // project is two steps (preview, then save after a native confirmation in main).
  'memory:overview': { request: z.strictObject({ projectId: z.string().max(64) }), response: MemoryOverviewSchema },
  'memory:read': {
    request: z.strictObject({ projectId: z.string().max(64), docType: z.enum(DOC_TYPES) }),
    response: z.strictObject({ content: z.string().max(MAX_DOC_BYTES * 2), location: z.string().max(400), exists: z.boolean() }),
  },
  'memory:preview': {
    request: z.strictObject({ projectId: z.string().max(64), docType: z.enum(DOC_TYPES), content: z.string().max(MAX_DOC_BYTES * 2) }),
    response: MemoryPreviewSchema,
  },
  'memory:save': {
    request: z.strictObject({ projectId: z.string().max(64), docType: z.enum(DOC_TYPES) }),
    response: MemoryApplyResultSchema,
  },
  'memory:setStorage': {
    request: z.strictObject({ projectId: z.string().max(64), storage: z.enum(MEMORY_STORAGES), docsDir: z.string().max(200) }),
    response: MemoryOverviewSchema,
  },
  'packs:build': { request: PackRequestSchema, response: ContextPackSchema },
  'packs:save': { request: z.strictObject({ projectId: z.string().max(64), title: z.string().max(120) }), response: ContextPackSchema },
  'packs:list': { request: z.strictObject({ projectId: z.string().max(64) }), response: z.array(PackSummarySchema) },
  'packs:get': { request: z.strictObject({ projectId: z.string().max(64), id: z.string().max(64) }), response: ContextPackSchema },
  'packs:refresh': { request: z.strictObject({ projectId: z.string().max(64), id: z.string().max(64) }), response: ContextPackSchema },
  'packs:remove': {
    request: z.strictObject({ projectId: z.string().max(64), id: z.string().max(64) }),
    response: z.strictObject({ removed: z.literal(true) }),
  },
  'handoffs:draft': { request: z.strictObject({ projectId: z.string().max(64) }), response: HandoffFieldsSchema },
  'handoffs:save': { request: z.strictObject({ projectId: z.string().max(64), fields: HandoffFieldsSchema }), response: HandoffSchema },
  'handoffs:list': { request: z.strictObject({ projectId: z.string().max(64) }), response: z.array(HandoffSchema) },
  'handoffs:latest': { request: z.strictObject({ projectId: z.string().max(64) }), response: HandoffSchema.nullable() },
  // Data and backups. Backups are named by file name; export, import and restore choose files in native dialogs in main,
  // and anything that overwrites data or adds a project folder is confirmed there too.
  'storage:status': { request: noInput, response: StorageStatusSchema },
  'storage:backupNow': { request: noInput, response: BackupItemSchema },
  'storage:restore': {
    request: z.strictObject({ backupId: z.string().min(1).max(200) }),
    response: z.strictObject({ staged: z.boolean() }),
  },
  'storage:exportData': { request: noInput, response: ExportResultSchema },
  'storage:previewImport': { request: noInput, response: ImportPreviewSchema },
  'storage:applyImport': {
    request: z.strictObject({ conflict: z.enum(IMPORT_CONFLICT_MODES) }),
    response: ImportResultSchema,
  },
} satisfies Record<ChannelName, { request: z.ZodType; response: z.ZodType }>;

/** What the renderer sends. */
export type RequestOf<C extends ChannelName> = z.input<(typeof contract)[C]['request']>;
/** What the handler receives, after defaults are applied. */
export type ParsedRequestOf<C extends ChannelName> = z.output<(typeof contract)[C]['request']>;
export type ResponseOf<C extends ChannelName> = z.output<(typeof contract)[C]['response']>;
