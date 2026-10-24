import { z } from 'zod';

// Project memory, context packs and session handoffs (spec §7, §8). Files are always addressed as a project id plus a
// project-relative path; the page never sends or receives a folder it could write to.

export const DOC_TYPES = [
  'PROJECT_CONTEXT',
  'GAME_DESIGN',
  'ARCHITECTURE',
  'ROADMAP',
  'TASKS',
  'DECISIONS',
  'SESSION_HANDOFF',
  'TEST_PLAN',
  'ASSET_REGISTER',
  'CHANGELOG',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_INFO: Record<DocType, { label: string; about: string; /** Part of the minimal set proposed when a project has no documentation. */ core: boolean }> = {
  PROJECT_CONTEXT: { label: 'Project context', about: 'Concise overview and important technical facts.', core: true },
  GAME_DESIGN: { label: 'Game design', about: 'Concept, mechanics, tone, intended experience and design constraints.', core: false },
  ARCHITECTURE: { label: 'Architecture', about: 'Systems, dependencies, data flow and extension points.', core: false },
  ROADMAP: { label: 'Roadmap', about: 'Milestones and longer-term goals.', core: false },
  TASKS: { label: 'Tasks', about: 'Prioritized development tasks and their status.', core: false },
  DECISIONS: { label: 'Decisions', about: 'Architectural decisions and why they were made.', core: true },
  SESSION_HANDOFF: { label: 'Session handoff', about: 'Current progress and how to resume work.', core: true },
  TEST_PLAN: { label: 'Test plan', about: 'Test procedures and known coverage gaps.', core: false },
  ASSET_REGISTER: { label: 'Asset register', about: 'Important assets, their source and where they are used.', core: false },
  CHANGELOG: { label: 'Changelog', about: 'Meaningful completed changes.', core: false },
};

/** Where a project's memory documents live: the app's database, the project folder, or a documentation folder inside the project. */
export const MEMORY_STORAGES = ['app', 'project', 'docs-dir'] as const;
export type MemoryStorage = (typeof MEMORY_STORAGES)[number];

export const MemoryDocSchema = z.object({
  type: z.enum(DOC_TYPES),
  /** Where this document is (or would be) stored, for display: `App database` or a project-relative path. */
  location: z.string().max(400),
  exists: z.boolean(),
  bytes: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime().optional(),
  /** A file with this document's name that already sits elsewhere in the project (project-relative). */
  foundInProject: z.string().max(400).optional(),
});
export type MemoryDoc = z.output<typeof MemoryDocSchema>;

export const MemoryOverviewSchema = z.object({
  storage: z.enum(MEMORY_STORAGES),
  /** Project-relative folder used when `storage` is `docs-dir`. */
  docsDir: z.string().max(200),
  docs: z.array(MemoryDocSchema),
  /** The minimal set proposed for this project, after looking at the documentation it already has. */
  proposal: z.array(z.object({ type: z.enum(DOC_TYPES), reason: z.string().max(300) })),
});
export type MemoryOverview = z.output<typeof MemoryOverviewSchema>;

export const DiffLineSchema = z.union([
  z.object({ kind: z.enum(['same', 'add', 'remove']), text: z.string().max(4000) }),
  z.object({ kind: z.literal('skip'), count: z.number().int().nonnegative() }),
]);

export const MemoryPreviewSchema = z.object({
  type: z.enum(DOC_TYPES),
  location: z.string().max(400),
  isNew: z.boolean(),
  unchanged: z.boolean(),
  /** True when the folder for the file does not exist yet and would be created. */
  createsFolder: z.boolean(),
  /** Undefined when a document is too long to diff; `bytes` still says how big the change is. */
  diff: z.array(DiffLineSchema).max(6500).optional(),
  bytes: z.number().int().nonnegative(),
  previousBytes: z.number().int().nonnegative(),
});
export type MemoryPreview = z.output<typeof MemoryPreviewSchema>;

export const MemoryApplyResultSchema = z.object({
  /** False when the user declined the confirmation. */
  written: z.boolean(),
  location: z.string().max(400),
});
export type MemoryApplyResult = z.output<typeof MemoryApplyResultSchema>;

export const MAX_DOC_BYTES = 256 * 1024;

// -------------------------------------------------------------------------------------------------- context packs

export const PackItemSchema = z.object({
  /** Project-relative path, or `app:<DOC_TYPE>` for a memory document stored in the app. */
  path: z.string().max(400),
  kind: z.enum(['file', 'memory', 'instructions']),
  reason: z.string().max(200),
  bytes: z.number().int().nonnegative(),
  /** Estimated tokens for this item (characters divided by four). */
  estimate: z.number().int().nonnegative(),
  /** For the stale check: modification time (files only) and SHA-256 of what was included. */
  mtimeMs: z.number().nonnegative(),
  sha256: z.string().max(64),
});
export type PackItem = z.output<typeof PackItemSchema>;

export const PackExcludedSchema = z.object({ path: z.string().max(400), reason: z.string().max(200) });

export const ContextPackSchema = z.object({
  /** Empty until the pack is saved. */
  id: z.string().max(64),
  projectId: z.string().max(64),
  title: z.string().max(120),
  task: z.string().max(4000),
  budget: z.number().int().positive(),
  /** Estimated: characters divided by four. Providers count differently. */
  estimate: z.number().int().nonnegative(),
  destination: z.string().max(120),
  items: z.array(PackItemSchema).max(200),
  excluded: z.array(PackExcludedSchema).max(100),
  /** Everything that would be sent, in order. */
  text: z.string().max(2_000_000),
  createdAt: z.iso.datetime(),
  /** Files that changed since the pack was built; empty for a fresh draft. */
  stale: z.array(z.object({ path: z.string().max(400), change: z.enum(['changed', 'missing']) })).max(200),
  saved: z.boolean(),
});
export type ContextPack = z.output<typeof ContextPackSchema>;

export const PackSummarySchema = z.object({
  id: z.string().max(64),
  title: z.string().max(120),
  destination: z.string().max(120),
  estimate: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  stale: z.number().int().nonnegative(),
});
export type PackSummary = z.output<typeof PackSummarySchema>;

export const PackRequestSchema = z.strictObject({
  projectId: z.string().max(64),
  task: z.string().min(1).max(4000),
  budget: z.number().int().min(500).max(200_000),
  /** Files the user picked by hand, project-relative. Sensitive, binary and huge ones are refused and listed. */
  extraFiles: z.array(z.string().min(1).max(400)).max(50),
  destination: z.string().max(120),
});
export type PackRequest = z.input<typeof PackRequestSchema>;

// ---------------------------------------------------------------------------------------------------------- handoffs

export const HANDOFF_FIELDS = ['requested', 'changed', 'verified', 'unfinished', 'risks', 'files', 'nextTask'] as const;
export type HandoffField = (typeof HANDOFF_FIELDS)[number];
export const HANDOFF_LABELS: Record<HandoffField, string> = {
  requested: 'What was requested',
  changed: 'What changed',
  verified: 'What was verified',
  unfinished: 'What remains unfinished',
  risks: 'Known bugs and risks',
  files: 'Relevant files and systems',
  nextTask: 'Next recommended task',
};

const field = z.string().max(8000);
export const HandoffFieldsSchema = z.strictObject({
  requested: field,
  changed: field,
  verified: field,
  unfinished: field,
  risks: field,
  files: field,
  nextTask: field,
});
export type HandoffFields = z.output<typeof HandoffFieldsSchema>;

export const HandoffSchema = HandoffFieldsSchema.extend({
  id: z.string().max(64),
  projectId: z.string().max(64),
  createdAt: z.iso.datetime(),
});
export type Handoff = z.output<typeof HandoffSchema>;

/** The handoff as Markdown, in the order of spec §8. */
export function handoffMarkdown(handoff: HandoffFields, title: string, at: string): string {
  const section = (heading: string, body: string): string => `## ${heading}\n\n${body.trim() === '' ? '_Nothing recorded._' : body.trim()}\n`;
  return [
    `# Session handoff: ${title}`,
    `_${at}_\n`,
    ...HANDOFF_FIELDS.map((key) => section(HANDOFF_LABELS[key], handoff[key])),
  ].join('\n');
}

/** A short starting text for a new memory document; the person edits it before anything is saved. */
export function docTemplate(type: DocType, projectName: string): string {
  const body: Record<DocType, string> = {
    PROJECT_CONTEXT: '## What this is\n\n## Technical facts\n\n- Engine and version:\n- How to build and run:\n- Where the important code lives:\n\n## Conventions\n',
    GAME_DESIGN: '## Concept\n\n## Mechanics\n\n## Tone and intended experience\n\n## Design constraints\n',
    ARCHITECTURE: '## Systems\n\n## Dependencies\n\n## Data flow\n\n## Extension points\n',
    ROADMAP: '## Current milestone\n\n## Next milestones\n\n## Longer-term goals\n',
    TASKS: '## In progress\n\n## Next\n\n## Later\n',
    DECISIONS: '## Decisions\n\nWrite each decision once: what was decided, why, and what was rejected.\n',
    SESSION_HANDOFF: '## What was requested\n\n## What changed\n\n## What was verified\n\n## What remains unfinished\n\n## Known bugs and risks\n\n## Relevant files and systems\n\n## Next recommended task\n',
    TEST_PLAN: '## How to test\n\n## Known coverage gaps\n',
    ASSET_REGISTER: '## Important assets\n\n| Asset | Source | Used in |\n|---|---|---|\n',
    CHANGELOG: '## Unreleased\n\n- \n',
  };
  return `# ${DOC_INFO[type].label}: ${projectName}\n\n${body[type]}`;
}
