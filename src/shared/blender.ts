import { z } from 'zod';
import { CapabilitySchema } from './unreal';

// Blender integration and asset management (spec §16 Blender, §17). Everything the page sends is a project id and a project-relative
// path chosen from what main listed, or an id; main resolves it inside the project. Blender is only ever started by main, on a copy.

export const BLEND_FORMATS = ['legacy', 'large-header', 'compressed', 'unknown'] as const;
export type BlendFormat = (typeof BLEND_FORMATS)[number];

export const BlendFileSchema = z.object({
  /** Project-relative, forward slashes. */
  path: z.string().max(400),
  bytes: z.number().nonnegative(),
  modifiedAt: z.iso.datetime(),
  format: z.enum(BLEND_FORMATS),
  /** Blender version that saved the file, read from its header ("5.1"), after decompressing the first 64 KB of a compressed file; null if unreadable. */
  version: z.string().max(20).nullable(),
  /** Siblings Blender wrote when it saved over the file (.blend1, .blend2). */
  backups: z.number().int().nonnegative(),
  tracked: z.boolean(),
  /** Saved by a newer Blender than any installed one, so the installed ones may not open it. */
  newerThanInstalled: z.boolean(),
});
export type BlendFile = z.output<typeof BlendFileSchema>;

export const BlenderInstallSchema = z.object({
  folder: z.string().max(500),
  version: z.string().max(40).nullable(),
  source: z.enum(['configured', 'default-folder', 'path']),
  note: z.string().max(300),
});
export type BlenderInstall = z.output<typeof BlenderInstallSchema>;

export const ScriptInfoSchema = z.object({
  path: z.string().max(400),
  bytes: z.number().int().nonnegative(),
  /** First 12 characters of the SHA-256 of the script text; the approval is bound to the whole hash. */
  hash: z.string().max(12),
  approved: z.boolean(),
  /** An approval exists but the script is different now, so it must be approved again. */
  changed: z.boolean(),
  approvalId: z.string().max(64).nullable(),
});
export type ScriptInfo = z.output<typeof ScriptInfoSchema>;

export const RUN_OUTCOMES = ['passed', 'failed', 'inconclusive'] as const;
export const InspectResultSchema = z.object({
  blender: z.string().max(40),
  scenes: z.array(z.string().max(120)).max(50),
  objects: z.number().int().nonnegative(),
  objectTypes: z.record(z.string().max(40), z.number().int().nonnegative()),
  meshes: z.number().int().nonnegative(),
  triangles: z.number().int().nonnegative(),
  materials: z.number().int().nonnegative(),
  images: z.number().int().nonnegative(),
  collections: z.number().int().nonnegative(),
  actions: z.number().int().nonnegative(),
  armatures: z.number().int().nonnegative(),
  libraries: z.array(z.string().max(300)).max(50),
  missingFiles: z.array(z.object({ kind: z.string().max(40), name: z.string().max(200), path: z.string().max(400) })).max(100),
  unitSystem: z.string().max(40),
  unitScale: z.number(),
});
export type InspectResult = z.output<typeof InspectResultSchema>;

export const BlenderRunSummarySchema = z.object({
  id: z.string().max(64),
  kind: z.enum(['inspect', 'script']),
  /** The .blend the run was made from (project-relative). */
  source: z.string().max(400),
  script: z.string().max(400).nullable(),
  blenderVersion: z.string().max(40).nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  status: z.string().max(30),
  exitCode: z.number().int().nullable(),
  outcome: z.enum(RUN_OUTCOMES),
  /** The original .blend has the same content after the run as before it. Always shown; a false value is an error. */
  originalUnchanged: z.boolean(),
  errorSummary: z.string().max(1000),
});
export type BlenderRunSummary = z.output<typeof BlenderRunSummarySchema>;

export const BlenderRunDetailSchema = BlenderRunSummarySchema.extend({
  log: z.string().max(300_000),
  truncated: z.boolean(),
  /** Files in the run's folder in the app's data area: results the script wrote and any modified copy. */
  outputs: z.array(z.object({ path: z.string().max(300), bytes: z.number().nonnegative() })).max(500),
  result: InspectResultSchema.nullable(),
});
export type BlenderRunDetail = z.output<typeof BlenderRunDetailSchema>;

export const ASSET_KINDS = ['model', 'texture', 'audio', 'animation', 'scene', 'script', 'other'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const TrackedAssetSchema = z.object({
  id: z.string().max(64),
  path: z.string().max(400),
  kind: z.enum(ASSET_KINDS),
  note: z.string().max(500),
  tags: z.array(z.string().max(40)).max(20),
  trackedAt: z.iso.datetime(),
  /** Compared with the file as it was when tracked (size and modification time). */
  status: z.enum(['unchanged', 'changed', 'missing']),
});
export type TrackedAsset = z.output<typeof TrackedAssetSchema>;

export const NAMING_ENGINES = ['unreal', 'godot', 'unity', 'generic'] as const;
export type NamingEngine = (typeof NAMING_ENGINES)[number];
export const ASSET_TYPES = ['static-mesh', 'skeletal-mesh', 'texture', 'material', 'material-instance', 'animation', 'blueprint', 'other'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const BriefFieldsSchema = z.object({
  name: z.string().min(1).max(120),
  assetType: z.enum(ASSET_TYPES),
  engine: z.enum(NAMING_ENGINES),
  purpose: z.string().max(2000),
  scale: z.string().max(500),
  formats: z.string().max(500),
  textures: z.string().max(1000),
  performance: z.string().max(1000),
  integration: z.string().max(2000),
  notes: z.string().max(4000),
  taskId: z.string().max(64).nullable(),
  assetId: z.string().max(64).nullable(),
});
export type BriefFields = z.output<typeof BriefFieldsSchema>;
export const BriefSchema = BriefFieldsSchema.extend({ id: z.string().max(64), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
export type Brief = z.output<typeof BriefSchema>;

export const NameCheckSchema = z.object({
  suggestion: z.string().max(200),
  problems: z.array(z.string().max(300)).max(10),
  rule: z.string().max(400),
});
export type NameCheck = z.output<typeof NameCheckSchema>;

export const BlenderViewSchema = z.object({
  installs: z.array(BlenderInstallSchema).max(20),
  /** Folders added by hand, in list order (removal is by position). */
  configuredPaths: z.array(z.string().max(500)).max(20),
  /** False when the project has no .blend file. */
  hasBlend: z.boolean(),
  files: z.array(BlendFileSchema).max(300),
  scripts: z.array(ScriptInfoSchema).max(50),
  runs: z.array(BlenderRunSummarySchema).max(30),
  assets: z.array(TrackedAssetSchema).max(500),
  capabilities: z.array(CapabilitySchema).max(20),
  truncated: z.boolean(),
  checkedAt: z.iso.datetime(),
});
export type BlenderView = z.output<typeof BlenderViewSchema>;

/** The text the Python script in the bundled inspect prints, after this marker. */
export const INSPECT_MARKER = 'GDCC_INSPECT_RESULT ';
