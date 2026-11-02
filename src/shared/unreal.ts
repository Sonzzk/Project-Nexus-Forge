import { z } from 'zod';

// Unreal Engine 5 integration (spec §16). Everything here is read from files on disk: the .uproject, the folders next to it, the engine
// installs the Epic launcher and the registry list. Binary assets are only counted and named, never opened.

export const CAPABILITY_STATES = ['implemented', 'unavailable', 'awaiting-configuration', 'experimental-off'] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];
export const CAPABILITY_LABELS: Record<CapabilityState, string> = {
  implemented: 'Implemented',
  unavailable: 'Unavailable',
  'awaiting-configuration': 'Awaiting configuration',
  'experimental-off': 'Off (opt-in, not built)',
};

export const CapabilitySchema = z.object({ id: z.string().max(60), label: z.string().max(120), state: z.enum(CAPABILITY_STATES), reason: z.string().max(500) });
export type Capability = z.output<typeof CapabilitySchema>;

export const UnrealTargetSchema = z.object({ name: z.string().max(100), type: z.enum(['Game', 'Editor', 'Client', 'Server', 'Program', 'unknown']), file: z.string().max(300) });
export type UnrealTarget = z.output<typeof UnrealTargetSchema>;

export const UnrealProjectSchema = z.object({
  /** The .uproject file name in the project folder. */
  uproject: z.string().max(200),
  name: z.string().max(120),
  fileVersion: z.number().int().nullable(),
  /** The engine the project asks for: a version such as "5.4", a source-build id in braces, or empty. */
  engineAssociation: z.string().max(200),
  description: z.string().max(500),
  category: z.string().max(100),
  modules: z.array(z.object({ name: z.string().max(100), type: z.string().max(40), loadingPhase: z.string().max(40) })).max(100),
  plugins: z.array(z.object({ name: z.string().max(100), enabled: z.boolean() })).max(300),
  /** Plugins that live in the project's own Plugins folder. */
  projectPlugins: z.array(z.string().max(100)).max(100),
  targets: z.array(UnrealTargetSchema).max(40),
  buildCsFiles: z.number().int().nonnegative(),
  folders: z.object({ source: z.boolean(), config: z.boolean(), content: z.boolean(), plugins: z.boolean(), binaries: z.boolean(), intermediate: z.boolean(), saved: z.boolean(), derivedDataCache: z.boolean() }),
  configFiles: z.array(z.string().max(100)).max(60),
  defaultMap: z.string().max(300).nullable(),
  editorStartupMap: z.string().max(300).nullable(),
  projectVersion: z.string().max(60).nullable(),
  content: z.object({
    assets: z.number().int().nonnegative(),
    bytes: z.number().nonnegative(),
    /** Asset paths in the engine's own form, for example /Game/Maps/Hall. */
    maps: z.array(z.string().max(300)).max(100),
    topFolders: z.array(z.object({ name: z.string().max(100), assets: z.number().int().nonnegative() })).max(40),
    truncated: z.boolean(),
  }),
  /** The project has C++ source, so it can be built from here. A Blueprint-only project has none. */
  hasSource: z.boolean(),
  notes: z.array(z.string().max(300)).max(10),
});
export type UnrealProject = z.output<typeof UnrealProjectSchema>;

export const ENGINE_SOURCES = ['launcher', 'registry', 'configured', 'default-folder'] as const;
export const EngineInstallSchema = z.object({
  /** For example UE_5.8 for a launcher install, a braces id for a registered source build, or the folder name. */
  id: z.string().max(200),
  version: z.string().max(40).nullable(),
  branch: z.string().max(80).nullable(),
  path: z.string().max(500),
  source: z.enum(ENGINE_SOURCES),
  hasEditor: z.boolean(),
  hasEditorCmd: z.boolean(),
  hasBuildBat: z.boolean(),
  /** Version file, editor and build script are all present. */
  complete: z.boolean(),
  note: z.string().max(300),
});
export type EngineInstall = z.output<typeof EngineInstallSchema>;

export const UnrealViewSchema = z.object({
  /** False when the selected project is not an Unreal project (no .uproject at its root). */
  isUnreal: z.boolean(),
  project: UnrealProjectSchema.nullable(),
  engines: z.array(EngineInstallSchema).max(40),
  /** The engine folders added by hand, in the order the list keeps them (removal is by position). */
  configuredPaths: z.array(z.string().max(500)).max(20),
  /** The install this project's EngineAssociation points at, and how it was matched. */
  resolved: z.object({ id: z.string().max(200), path: z.string().max(500), how: z.string().max(200) }).nullable(),
  resolveNote: z.string().max(400),
  capabilities: z.array(CapabilitySchema).max(20),
  /** Commands found for this project (approve and run them under Permissions on the AI Workbench). */
  commands: z.array(z.object({ label: z.string().max(200), writes: z.boolean() })).max(40),
  checkedAt: z.iso.datetime(),
});
export type UnrealView = z.output<typeof UnrealViewSchema>;

export const OPEN_TARGETS = ['project', 'source', 'config', 'content', 'plugins', 'logs', 'engine'] as const;
export type OpenTarget = (typeof OPEN_TARGETS)[number];
