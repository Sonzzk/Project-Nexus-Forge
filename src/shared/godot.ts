import { z } from 'zod';
import { CapabilitySchema } from './unreal';

// Godot integration (spec §16 Godot). Everything is read from files on disk: project.godot, export_presets.cfg, the GDScript files and
// the executables of the installed engine. The page names a project id; main resolves everything inside the project.

export const GodotInstallSchema = z.object({
  folder: z.string().max(500),
  /** The editor program; commands and the editor run it (output is read through pipes). */
  exe: z.string().max(500).nullable(),
  /** The console wrapper of the same editor; used only when the editor program itself is missing. */
  consoleExe: z.string().max(500).nullable(),
  /** "4.3", from `godot --version`, or from the file name when that cannot be run. */
  version: z.string().max(40).nullable(),
  /** "stable", "beta2", "dev"..., from `--version`. */
  release: z.string().max(40).nullable(),
  mono: z.boolean(),
  source: z.enum(['configured', 'default-folder', 'path']),
  note: z.string().max(300),
});
export type GodotInstall = z.output<typeof GodotInstallSchema>;

export const ExportPresetSchema = z.object({
  name: z.string().max(120),
  platform: z.string().max(60),
  runnable: z.boolean(),
  /** The path the preset itself holds, relative to the project ("" when none). */
  exportPath: z.string().max(400),
  /** Why the app offers no export command for this preset ("" when it does). */
  skipped: z.string().max(300),
});
export type ExportPreset = z.output<typeof ExportPresetSchema>;

export const GodotProjectSchema = z.object({
  name: z.string().max(120),
  configVersion: z.number().int().nullable(),
  /** From config/features: "4.3". Null when the file does not say. */
  engineVersion: z.string().max(20).nullable(),
  features: z.array(z.string().max(60)).max(30),
  /** "Forward Plus", "Mobile" or "Compatibility" when listed in the features. */
  renderer: z.string().max(40).nullable(),
  csharp: z.boolean(),
  mainScene: z.string().max(300).nullable(),
  autoloads: z.array(z.object({ name: z.string().max(100), path: z.string().max(300) })).max(50),
  enabledPlugins: z.array(z.string().max(300)).max(50),
  addons: z.array(z.object({ folder: z.string().max(100), name: z.string().max(120), version: z.string().max(40) })).max(50),
  presets: z.array(ExportPresetSchema).max(40),
  scripts: z.object({
    gdscript: z.number().int().nonnegative(),
    csharp: z.number().int().nonnegative(),
    scenes: z.number().int().nonnegative(),
    resources: z.number().int().nonnegative(),
    /** `class_name` declarations (name, project-relative file, parent class). */
    classes: z.array(z.object({ name: z.string().max(100), path: z.string().max(300), extends: z.string().max(100) })).max(200),
    truncated: z.boolean(),
  }),
  /** The test framework found (GUT, GdUnit4) and where its tests live. */
  tests: z.object({ framework: z.enum(['gut', 'gdunit4']).nullable(), directory: z.string().max(200).nullable(), hasConfig: z.boolean() }),
  notes: z.array(z.string().max(300)).max(10),
});
export type GodotProject = z.output<typeof GodotProjectSchema>;

export const GodotViewSchema = z.object({
  /** False when the selected project has no readable project.godot at its root. */
  isGodot: z.boolean(),
  project: GodotProjectSchema.nullable(),
  installs: z.array(GodotInstallSchema).max(20),
  configuredPaths: z.array(z.string().max(500)).max(20),
  /** The install commands would use, and why it was chosen. */
  resolved: z.object({ folder: z.string().max(500), version: z.string().max(40).nullable(), how: z.string().max(200) }).nullable(),
  resolveNote: z.string().max(400),
  editor: z.object({ running: z.boolean(), startedAt: z.iso.datetime().nullable() }),
  capabilities: z.array(CapabilitySchema).max(20),
  /** Commands found for this project (approve and run them under Permissions). */
  commands: z.array(z.object({ label: z.string().max(200), writes: z.boolean() })).max(60),
  checkedAt: z.iso.datetime(),
});
export type GodotView = z.output<typeof GodotViewSchema>;

export const GODOT_OPEN_TARGETS = ['project', 'addons'] as const;
export type GodotOpenTarget = (typeof GODOT_OPEN_TARGETS)[number];
