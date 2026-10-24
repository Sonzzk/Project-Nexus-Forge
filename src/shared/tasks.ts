import { z } from 'zod';

// Task planning (spec §10, §19, §20): tasks with a real lifecycle, milestones, a bugs and risks register, and progress
// that is only ever computed from stored tasks. Paths in `files` are project-relative text, never opened by this module.

export const TASK_STATUSES = ['inbox', 'planned', 'ready', 'in-progress', 'review', 'testing', 'done', 'blocked', 'cancelled', 'failed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  inbox: 'Inbox',
  planned: 'Planned',
  ready: 'Ready',
  'in-progress': 'In progress',
  review: 'Review',
  testing: 'Testing',
  done: 'Done',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

/** The columns of the board, in lifecycle order; blocked, cancelled and failed are shown in their own group. */
export const BOARD_STATUSES = ['inbox', 'planned', 'ready', 'in-progress', 'review', 'testing', 'done'] as const satisfies readonly TaskStatus[];
export const SIDE_STATUSES = ['blocked', 'failed', 'cancelled'] as const satisfies readonly TaskStatus[];

/**
 * Valid moves (spec §10: Inbox, Planned, Ready, In Progress, Review, Testing, Done, plus blocked, cancelled and failed).
 * A blocked task goes back to where it was, to Planned, or is cancelled; that is decided from the task's own history.
 */
export const TRANSITIONS: Record<Exclude<TaskStatus, 'blocked'>, readonly TaskStatus[]> = {
  inbox: ['planned', 'cancelled'],
  planned: ['inbox', 'ready', 'blocked', 'cancelled'],
  ready: ['planned', 'in-progress', 'blocked', 'cancelled'],
  'in-progress': ['ready', 'review', 'testing', 'blocked', 'failed', 'cancelled'],
  review: ['in-progress', 'testing', 'done', 'blocked', 'failed'],
  testing: ['review', 'in-progress', 'done', 'blocked', 'failed'],
  done: ['in-progress'],
  failed: ['ready', 'planned', 'cancelled'],
  cancelled: ['inbox'],
};

export const PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = { low: 'Low', normal: 'Normal', high: 'High', critical: 'Critical' };

export const COMPLEXITIES = ['', 'xs', 's', 'm', 'l', 'xl'] as const;
export type Complexity = (typeof COMPLEXITIES)[number];
export const COMPLEXITY_LABELS: Record<Complexity, string> = { '': 'Not estimated', xs: 'XS (minutes)', s: 'S (an hour)', m: 'M (a few hours)', l: 'L (a day)', xl: 'XL (several days; consider splitting)' };

/** The logical roles of spec §11. Step 11 defines their behavior; here a task only suggests one. */
export const ROLES = ['', 'planner', 'implementer', 'reviewer', 'qa', 'docs', 'assets'] as const;
export type RoleId = (typeof ROLES)[number];
export const ROLE_LABELS: Record<RoleId, string> = {
  '': 'No suggestion',
  planner: 'Planner / architect',
  implementer: 'Implementer',
  reviewer: 'Code reviewer',
  qa: 'QA and debugging',
  docs: 'Documentation',
  assets: 'Asset and level design',
};

export const USAGE_CATEGORIES = ['', 'local', 'subscription', 'metered'] as const;
export type UsageCategory = (typeof USAGE_CATEGORIES)[number];
export const USAGE_LABELS: Record<UsageCategory, string> = { '': 'Unknown', local: 'Local model (free)', subscription: 'Subscription', metered: 'Metered (paid per use)' };

export const TEMPLATE_IDS = ['gameplay', 'ui', 'ai-behavior', 'level-design', 'asset-integration', 'performance', 'bug-fixing', 'refactoring', 'release'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface TaskTemplate {
  id: TemplateId;
  label: string;
  subsystem: string;
  complexity: Complexity;
  role: RoleId;
  description: string;
  acceptance: string[];
  testRequirements: string;
}

/** The nine categories of spec §10. They only prefill the form; the person edits everything before saving. */
export const TASK_TEMPLATES: readonly TaskTemplate[] = [
  { id: 'gameplay', label: 'Gameplay mechanic', subsystem: 'Gameplay', complexity: 'm', role: 'implementer', description: 'What the player does, what the game does in response, and how it should feel.', acceptance: ['The mechanic works as described in a test level', 'It does not break existing controls', 'Values that affect feel are easy to tune'], testRequirements: 'Play through the mechanic in a test level; add an automated test for any rule that can be tested without playing.' },
  { id: 'ui', label: 'User interface', subsystem: 'UI', complexity: 's', role: 'implementer', description: 'Which screen or element, what it shows, and how the player uses it.', acceptance: ['Readable at the supported resolutions', 'Works with keyboard/controller and mouse where applicable', 'No overlap or clipped text'], testRequirements: 'Check at the smallest and largest supported resolution.' },
  { id: 'ai-behavior', label: 'AI behavior', subsystem: 'AI', complexity: 'l', role: 'implementer', description: 'The behavior, what triggers it, and how the player can influence or escape it.', acceptance: ['The agent reacts to the triggers listed', 'It never gets stuck in a test level', 'Behavior is observable with debug output'], testRequirements: 'Run the agent in a test level for several minutes and note any stuck states.' },
  { id: 'level-design', label: 'Level design', subsystem: 'Level', complexity: 'l', role: 'assets', description: 'Purpose of the space, intended pacing, landmarks and the path the player should take.', acceptance: ['The layout supports the intended pacing', 'Navigation works for the player and for AI', 'Lighting and sound match the intended mood'], testRequirements: 'Walk the intended route and the shortcuts; check frame rate in the heaviest view.' },
  { id: 'asset-integration', label: 'Asset integration', subsystem: 'Assets', complexity: 's', role: 'assets', description: 'Which assets, where they come from, naming and import settings.', acceptance: ['Assets follow the naming standard', 'Import settings are recorded', 'Nothing else in the project changed'], testRequirements: 'Open the asset in the engine and in the scene where it is used.' },
  { id: 'performance', label: 'Performance', subsystem: 'Performance', complexity: 'm', role: 'qa', description: 'The measured problem, where it was measured and the target.', acceptance: ['Before and after measurements are recorded', 'The target is met in the measured scene', 'No visible quality regression'], testRequirements: 'Measure in the same scene and settings before and after.' },
  { id: 'bug-fixing', label: 'Bug fix', subsystem: '', complexity: 's', role: 'qa', description: 'Steps to reproduce, what happens, what should happen.', acceptance: ['The bug no longer reproduces with the recorded steps', 'A test or a written check prevents it from coming back where practical'], testRequirements: 'Repeat the reproduction steps; run the project tests.' },
  { id: 'refactoring', label: 'Refactoring', subsystem: '', complexity: 'm', role: 'implementer', description: 'What is hard to change today and the smallest change that fixes that. Behavior must not change.', acceptance: ['Behavior is unchanged', 'The project tests still pass', 'The change is limited to the stated area'], testRequirements: 'Run the full test suite before and after.' },
  { id: 'release', label: 'Release preparation', subsystem: 'Release', complexity: 'm', role: 'docs', description: 'The build target, the checklist for this release and who signs off.', acceptance: ['The build runs on a clean machine', 'Known issues are listed', 'Version and changelog are updated'], testRequirements: 'Install and play the packaged build from scratch.' },
];

export const SCOPE_TIERS = ['dream', 'prototype', 'slice', 'release'] as const;
export type ScopeTier = (typeof SCOPE_TIERS)[number];
export const SCOPE_LABELS: Record<ScopeTier, string> = { dream: 'Long-term dream', prototype: 'First playable prototype', slice: 'Vertical slice', release: 'Release' };

export const MILESTONE_STATUSES = ['planned', 'active', 'done', 'cancelled'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const RISK_KINDS = ['bug', 'risk'] as const;
export const SEVERITIES = ['low', 'medium', 'high'] as const;
export const RISK_STATUSES = ['open', 'mitigated', 'closed'] as const;

// ---------------------------------------------------------------------------------------------------------- schemas

const id = z.string().min(1).max(64);
/** A project-relative path as text: not absolute, no `..`, no drive. It is never opened by the task code. */
const relativePath = z
  .string()
  .min(1)
  .max(400)
  .refine((p) => !/^([a-zA-Z]:|[\\/])/.test(p) && !p.split(/[\\/]/).includes('..') && !p.includes('\0'), 'must be a path inside the project');

export const TaskFieldsSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(8000),
  milestoneId: id.nullable(),
  parentId: id.nullable(),
  subsystem: z.string().max(80),
  priority: z.enum(PRIORITIES),
  complexity: z.enum(COMPLEXITIES),
  category: z.enum(['', ...TEMPLATE_IDS]),
  acceptance: z.array(z.string().trim().min(1).max(500)).max(30),
  files: z.array(relativePath).max(50),
  role: z.enum(ROLES),
  provider: z.string().max(80),
  usage: z.enum(USAGE_CATEGORIES),
  testRequirements: z.string().max(4000),
  resultNotes: z.string().max(4000),
});
export type TaskFields = z.output<typeof TaskFieldsSchema>;

export const TaskCreateSchema = TaskFieldsSchema.partial({
  description: true, milestoneId: true, parentId: true, subsystem: true, priority: true, complexity: true, category: true, acceptance: true, files: true, role: true, provider: true, usage: true, testRequirements: true, resultNotes: true,
}).extend({ projectId: id, status: z.enum(['inbox', 'planned']).optional() });
export type TaskCreate = z.input<typeof TaskCreateSchema>;

export const TaskPatchSchema = TaskFieldsSchema.partial().extend({ id });
export type TaskPatch = z.input<typeof TaskPatchSchema>;

export const TaskSchema = TaskFieldsSchema.extend({
  id,
  projectId: id,
  status: z.enum(TASK_STATUSES),
  /** Approval of the plan before work starts (spec §10); null when not approved. */
  planApprovedAt: z.iso.datetime().nullable(),
  dependsOn: z.array(id).max(100),
  /** Dependencies that are not done yet, with their state. Empty means the task can start. */
  waitingOn: z.array(z.object({ id, title: z.string().max(200), status: z.enum(TASK_STATUSES) })).max(100),
  /** Statuses this task can move to right now (lifecycle rules only; some moves can still be refused with a reason). */
  allowedNext: z.array(z.enum(TASK_STATUSES)).max(10),
  /** Number of subtasks. */
  children: z.number().int().nonnegative(),
  order: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  doneAt: z.iso.datetime().nullable(),
});
export type Task = z.output<typeof TaskSchema>;

export const NoteSchema = z.object({ id, taskId: id, createdAt: z.iso.datetime(), text: z.string().max(4000) });
export type Note = z.output<typeof NoteSchema>;

export const BreakdownSchema = z.strictObject({
  projectId: id,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(8000),
  milestoneId: id.nullable(),
  /** Each step becomes a subtask. */
  steps: z.array(z.strictObject({ title: z.string().trim().min(1).max(200), acceptance: z.array(z.string().trim().min(1).max(500)).max(10) })).min(1).max(30),
  /** Make each step depend on the one before it. */
  chain: z.boolean(),
});
export type Breakdown = z.input<typeof BreakdownSchema>;

export const RecommendationSchema = z.object({
  task: TaskSchema,
  score: z.number(),
  /** Why this task, in plain words. */
  reasons: z.array(z.string().max(200)).max(10),
});
export type Recommendation = z.output<typeof RecommendationSchema>;

export const RecommendationsSchema = z.object({
  items: z.array(RecommendationSchema).max(5),
  /** Why there is nothing to recommend, when the list is empty. */
  message: z.string().max(300),
});
export type Recommendations = z.output<typeof RecommendationsSchema>;

export const ProgressSchema = z.object({
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  inProgress: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  /** Done divided by total, rounded; null when there are no tasks (never an invented number). */
  percent: z.number().int().min(0).max(100).nullable(),
});
export type Progress = z.output<typeof ProgressSchema>;

export const MilestoneFieldsSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000),
  status: z.enum(MILESTONE_STATUSES),
  scopeTier: z.enum(SCOPE_TIERS),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});
export const MilestoneCreateSchema = MilestoneFieldsSchema.partial({ description: true, status: true, targetDate: true }).extend({ projectId: id });
export const MilestonePatchSchema = MilestoneFieldsSchema.partial().extend({ id });
export const MilestoneSchema = MilestoneFieldsSchema.extend({
  id,
  projectId: id,
  order: z.number().int(),
  progress: ProgressSchema,
  createdAt: z.iso.datetime(),
});
export type Milestone = z.output<typeof MilestoneSchema>;

export const SnapshotSchema = z.object({
  id,
  milestoneId: id,
  takenAt: z.iso.datetime(),
  label: z.string().max(120),
  progress: ProgressSchema,
  byStatus: z.record(z.string().max(20), z.number().int().nonnegative()),
});
export type Snapshot = z.output<typeof SnapshotSchema>;

export const RiskFieldsSchema = z.strictObject({
  kind: z.enum(RISK_KINDS),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000),
  severity: z.enum(SEVERITIES),
  status: z.enum(RISK_STATUSES),
  taskId: id.nullable(),
});
export const RiskCreateSchema = RiskFieldsSchema.partial({ description: true, severity: true, status: true, taskId: true }).extend({ projectId: id });
export const RiskPatchSchema = RiskFieldsSchema.partial().extend({ id });
export const RiskSchema = RiskFieldsSchema.extend({ id, projectId: id, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
export type Risk = z.output<typeof RiskSchema>;

export const PortfolioEntrySchema = z.object({
  projectId: id,
  name: z.string().max(120),
  projectStatus: z.enum(['active', 'paused', 'archived']),
  currentMilestone: z.string().max(200).nullable(),
  progress: ProgressSchema,
  openBugs: z.number().int().nonnegative(),
  openRisks: z.number().int().nonnegative(),
});
export type PortfolioEntry = z.output<typeof PortfolioEntrySchema>;

// ------------------------------------------------------------------------------------------------------------ rules

/** Statuses a task can move to from `from`, given where a blocked task came from. */
export function allowedNext(from: TaskStatus, blockedFrom: TaskStatus | null): TaskStatus[] {
  if (from === 'blocked') return [...new Set<TaskStatus>([blockedFrom ?? 'planned', 'planned', 'cancelled'])].filter((s) => s !== 'blocked');
  return [...TRANSITIONS[from]];
}

/** True when a dependency no longer holds a task back. */
export const satisfiesDependency = (status: TaskStatus): boolean => status === 'done' || status === 'cancelled';

/** True when adding the edge `task -> dependsOn` would close a loop. `edges` maps a task to what it depends on. */
export function wouldCycle(edges: ReadonlyMap<string, readonly string[]>, task: string, dependsOn: string): boolean {
  if (task === dependsOn) return true;
  const seen = new Set<string>();
  const stack = [dependsOn];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === task) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(edges.get(current) ?? []));
  }
  return false;
}

export function progressOf(statuses: readonly TaskStatus[]): Progress {
  const counted = statuses.filter((s) => s !== 'cancelled');
  const done = counted.filter((s) => s === 'done').length;
  return {
    total: counted.length,
    done,
    inProgress: counted.filter((s) => s === 'in-progress' || s === 'review' || s === 'testing').length,
    blocked: counted.filter((s) => s === 'blocked').length,
    percent: counted.length === 0 ? null : Math.round((done / counted.length) * 100),
  };
}
