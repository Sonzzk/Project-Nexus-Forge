import { z } from 'zod';
import { NAMING_ENGINES } from './blender';

// The asset inventory (spec §17): a metadata-only index of a project's game content (path, category, size, modified time), the person's
// own tags, notes, source and task references on top of it, naming and folder checks that only report, previews of common image
// formats, and moves that happen only after a preview and a confirmation. Nothing here opens an engine's binary asset or makes one.

export const ASSET_CATEGORIES = ['model', 'texture', 'material', 'audio', 'animation', 'scene', 'script', 'font', 'video', 'build', 'engine'] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<AssetCategory, string> = {
  model: '3D models',
  texture: 'Textures and images',
  material: 'Materials and shaders',
  audio: 'Audio',
  animation: 'Animations',
  scene: 'Levels and scenes',
  script: 'Scripts',
  font: 'Fonts',
  video: 'Videos',
  build: 'Exported builds',
  engine: 'Engine assets (binary or serialized)',
};

const BY_EXTENSION: Record<string, AssetCategory> = {};
const register = (category: AssetCategory, extensions: string): void => {
  for (const extension of extensions.split(' ')) BY_EXTENSION[extension] = category;
};
register('model', 'blend fbx obj gltf glb usd usda usdc usdz abc dae stl ply 3ds');
register('texture', 'png jpg jpeg tga exr hdr tif tiff bmp webp psd dds ktx ktx2 gif svg');
register('material', 'mat mtl material gdshader shader hlsl usf ush shadergraph');
register('audio', 'wav ogg mp3 flac aif aiff m4a opus');
register('animation', 'anim bvh controller');
register('scene', 'umap unity tscn scn');
register('script', 'py gd cs cpp hpp h c js mjs ts tsx jsx lua');
register('font', 'ttf otf woff woff2 fnt');
register('video', 'mp4 webm mov avi mkv ogv');
register('engine', 'uasset uexp ubulk prefab asset tres res');

/** Folder names that mark an exported build, and the file types that count as one inside them (an executable, a pack or an installer). */
const BUILD_FOLDERS = new Set(['build', 'builds', 'dist', 'export', 'exports', 'release', 'releases', 'packaged', 'staging']);
const BUILD_FILES = new Set(['exe', 'pck', 'pak', 'apk', 'aab', 'dmg', 'zip', '7z', 'x86_64', 'wasm', 'ipa']);
const ALWAYS_BUILD = new Set(['pck', 'apk', 'aab', 'ipa']);

const extensionOf = (path: string): string => {
  const name = path.slice(path.search(/[^\\/]*$/));
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
};
export { extensionOf };

/** What kind of content a project-relative path is, from its folder names and extension, or null when it is not game content. */
export function categoryOfPath(path: string): AssetCategory | null {
  const extension = extensionOf(path);
  if (extension === '') return null;
  const folders = path.replace(/\\/g, '/').split('/').slice(0, -1).map((s) => s.toLowerCase());
  if (ALWAYS_BUILD.has(extension)) return 'build';
  if (BUILD_FILES.has(extension) && folders.some((f) => BUILD_FOLDERS.has(f))) return 'build';
  return BY_EXTENSION[extension] ?? null;
}

/** Image types that can be shown as previews. SVG is left out: it can carry script, so it is listed by metadata only. */
export const PREVIEW_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
export const previewTypeOf = (path: string): string | undefined => PREVIEW_TYPES[extensionOf(path)];

/** The address the page uses to show a preview; main refuses anything but an image inside a registered project. */
export const PREVIEW_SCHEME = 'gdcc-asset';
export const previewUrl = (projectId: string, path: string): string => `${PREVIEW_SCHEME}://preview/${encodeURIComponent(projectId)}?p=${encodeURIComponent(path)}`;

// ------------------------------------------------------------------------------------------------------------- index

export const TAG_LIMITS = { tags: 20, tagLength: 40, note: 500, source: 300, usage: 500, tasks: 20 } as const;

export const AssetItemSchema = z.object({
  /** Project-relative, forward slashes. */
  path: z.string().max(400),
  category: z.enum(ASSET_CATEGORIES),
  extension: z.string().max(20),
  bytes: z.number().nonnegative(),
  modifiedAt: z.iso.datetime(),
  previewable: z.boolean(),
  /** Set once the person tags it, writes a note, gives a source or links a task. */
  annotation: z
    .object({
      id: z.string().max(64),
      note: z.string().max(TAG_LIMITS.note),
      tags: z.array(z.string().max(TAG_LIMITS.tagLength)).max(TAG_LIMITS.tags),
      source: z.string().max(TAG_LIMITS.source),
      usage: z.string().max(TAG_LIMITS.usage),
      taskIds: z.array(z.string().max(64)).max(TAG_LIMITS.tasks),
      status: z.enum(['unchanged', 'changed', 'missing']),
    })
    .nullable(),
});
export type AssetItem = z.output<typeof AssetItemSchema>;

export const ScanSummarySchema = z.object({
  scannedAt: z.iso.datetime(),
  /** Files and folders looked at. */
  entries: z.number().int().nonnegative(),
  /** Game content files in the index. */
  files: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  /** The scan stopped at its file or time limit, so the index is partial and removals were not applied. */
  truncated: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});
export type ScanSummary = z.output<typeof ScanSummarySchema>;

export const AssetSearchRequestSchema = z.strictObject({
  projectId: z.string().max(64),
  query: z.string().max(200).default(''),
  category: z.enum(ASSET_CATEGORIES).nullable().default(null),
  tag: z.string().max(TAG_LIMITS.tagLength).default(''),
  taskId: z.string().max(64).nullable().default(null),
  /** Only files the person has annotated. */
  annotatedOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(60),
  offset: z.number().int().min(0).max(1_000_000).default(0),
});
export type AssetSearchRequest = z.input<typeof AssetSearchRequestSchema>;

export const AssetSearchResultSchema = z.object({
  items: z.array(AssetItemSchema).max(200),
  /** Matches before the page limit. */
  total: z.number().int().nonnegative(),
  /** Files per category over the whole index (not only the matches). */
  counts: z.record(z.enum(ASSET_CATEGORIES), z.number().int().nonnegative()),
  scan: ScanSummarySchema.nullable(),
});
export type AssetSearchResult = z.output<typeof AssetSearchResultSchema>;

export const AnnotateRequestSchema = z.strictObject({
  projectId: z.string().max(64),
  relativePath: z.string().min(1).max(400),
  note: z.string().max(TAG_LIMITS.note).default(''),
  tags: z.array(z.string().max(TAG_LIMITS.tagLength)).max(TAG_LIMITS.tags).default([]),
  source: z.string().max(TAG_LIMITS.source).default(''),
  usage: z.string().max(TAG_LIMITS.usage).default(''),
  taskIds: z.array(z.string().max(64)).max(TAG_LIMITS.tasks).default([]),
});
export type AnnotateRequest = z.input<typeof AnnotateRequestSchema>;

// ------------------------------------------------------------------------------------------------------------- checks

export const CHECK_RULES = ['spaces', 'characters', 'case', 'prefix', 'duplicate-name', 'depth', 'loose-root', 'mixed-case-folder'] as const;
export const CheckFindingSchema = z.object({
  rule: z.enum(CHECK_RULES),
  path: z.string().max(400),
  message: z.string().max(300),
  /** A name that would satisfy the rule, when there is one. Nothing is renamed by the check. */
  suggestion: z.string().max(400).nullable(),
});
export type CheckFinding = z.output<typeof CheckFindingSchema>;

export const CheckReportSchema = z.object({
  /** The convention applied, chosen from the project type. */
  engine: z.enum(NAMING_ENGINES),
  rule: z.string().max(400),
  checked: z.number().int().nonnegative(),
  /** Findings per rule, over all files; `findings` holds the first ones. */
  counts: z.record(z.enum(CHECK_RULES), z.number().int().nonnegative()),
  findings: z.array(CheckFindingSchema).max(300),
  /** Findings beyond the ones listed. */
  more: z.number().int().nonnegative(),
  note: z.string().max(400),
});
export type CheckReport = z.output<typeof CheckReportSchema>;

// -------------------------------------------------------------------------------------------------- moves and removal

export const MoveSchema = z.strictObject({ from: z.string().min(1).max(400), to: z.string().min(1).max(400) });
export type Move = z.output<typeof MoveSchema>;
export const MAX_MOVES = 200;

export const OpsPreviewSchema = z.object({
  kind: z.enum(['move', 'trash']),
  /** Each file and where it would go (a move) or that it goes to the Recycle Bin (trash). */
  items: z.array(z.object({ from: z.string().max(400), to: z.string().max(400).nullable(), bytes: z.number().nonnegative(), tracked: z.boolean() })).max(MAX_MOVES),
  /** Why the operation cannot run as asked; empty when it can. */
  problems: z.array(z.string().max(300)).max(60),
  /** What the app does not do for the person, such as updating references inside scenes or materials. */
  warnings: z.array(z.string().max(300)).max(10),
  /** The project-writes permission is already granted, so the window is the only step left. */
  permitted: z.boolean(),
});
export type OpsPreview = z.output<typeof OpsPreviewSchema>;

export const OpsResultSchema = z.object({
  /** False when you declined a window; nothing changed. */
  done: z.boolean(),
  count: z.number().int().nonnegative(),
});
export type OpsResult = z.output<typeof OpsResultSchema>;
