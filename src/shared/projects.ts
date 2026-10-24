import { z } from 'zod';

// Spec §6: a project is a folder the user registered. Type comes from the files in it, never from its name.

export const PROJECT_TYPES = [
  'unreal',
  'unity',
  'godot',
  'web-vite',
  'web',
  'general-code',
  'custom',
] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  unreal: 'Unreal Engine',
  unity: 'Unity',
  godot: 'Godot',
  'web-vite': 'Vite web project',
  web: 'Web project',
  'general-code': 'General code project',
  custom: 'Custom or unidentified',
};

/** Statuses the user chooses. A folder that cannot be found is reported separately (`folderExists`). */
export const PROJECT_STATUSES = ['active', 'paused', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const EvidenceSchema = z.object({
  /** Project-relative path of the file that was read. */
  path: z.string().max(300),
  detail: z.string().max(300),
});
export type Evidence = z.output<typeof EvidenceSchema>;

export const DetectionSchema = z.object({
  type: z.enum(PROJECT_TYPES),
  engine: z.string().max(60).optional(),
  engineVersion: z.string().max(60).optional(),
  /** `confirmed`: a file that defines the project type was found. `inferred`: only hints. */
  confidence: z.enum(['confirmed', 'inferred']),
  evidence: z.array(EvidenceSchema).max(40),
});
export type Detection = z.output<typeof DetectionSchema>;

export const ProjectSchema = z.object({
  id: z.string().max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(2000),
  type: z.enum(PROJECT_TYPES),
  typeSource: z.enum(['detected', 'manual']),
  engine: z.string().max(60).optional(),
  engineVersion: z.string().max(60).optional(),
  /** Shown to the user; never sent back by the renderer. */
  rootPath: z.string().max(1000),
  status: z.enum(PROJECT_STATUSES),
  folderExists: z.boolean(),
  tags: z.array(z.string().min(1).max(40)).max(30),
  instructions: z.string().max(20000),
  aiPrefs: z.record(z.string(), z.unknown()),
  backupPrefs: z.record(z.string(), z.unknown()),
  detection: DetectionSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Project = z.output<typeof ProjectSchema>;

export const ProjectPatchSchema = z.strictObject({
  id: z.string().max(64),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  instructions: z.string().max(20000).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  /** A type to force, or `null` to go back to what the files say. */
  typeOverride: z.enum(PROJECT_TYPES).nullable().optional(),
});
export type ProjectPatch = z.input<typeof ProjectPatchSchema>;
