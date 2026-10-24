import { z } from 'zod';
import { RouteSchema } from './routing';
import { PRIORITIES, type RoleId, type Task } from './tasks';

// Agent roles and workflows (spec §11): roles, run records, their visible states and the workflow templates, and what a run
// would do and with which provider. Nothing here starts a program or calls a provider: the run queue (src/main/planning/queue.ts,
// Step 13) does, for read-only runs only until Step 15.

export const AGENT_ROLE_IDS = ['planner', 'implementer', 'reviewer', 'qa', 'docs', 'assets'] as const satisfies readonly Exclude<RoleId, ''>[];
export type AgentRoleId = (typeof AGENT_ROLE_IDS)[number];

export interface AgentRole {
  id: AgentRoleId;
  label: string;
  purpose: string;
  /** What the role hands back, so the person knows what to expect. */
  expectedOutput: string;
  /** Read-only roles can look at the project but never change it. Only the implementer writes (spec §11). */
  writeCapable: boolean;
  /** The text a provider would receive, with `{{...}}` placeholders filled in from the task. */
  promptTemplate: string;
}

export const AGENT_ROLES: readonly AgentRole[] = [
  {
    id: 'planner',
    label: 'Planner / architect',
    purpose: 'Analyzes the requirement, finds dependencies, proposes an approach and names the risks. Read-only.',
    expectedOutput: 'A written plan: steps, files likely to change, risks, open questions.',
    writeCapable: false,
    promptTemplate:
      'You are the planner for the project "{{project}}". Read the project as needed but do not change any file.\n\nTask: {{title}}\n{{description}}\n\nAcceptance criteria:\n{{acceptance}}\n\nRelevant files:\n{{files}}\n\nProduce a short plan: the steps in order, the files likely to change, the risks, and anything that needs a decision before work starts. Do not invent requirements.',
  },
  {
    id: 'implementer',
    label: 'Implementer',
    purpose: 'Implements one approved task at a time and is the only role that writes to the project working files.',
    expectedOutput: 'The change itself in the working tree, and a note of what was changed and how it was checked.',
    writeCapable: true,
    promptTemplate:
      'You are the implementer for the project "{{project}}". Implement only this approved task and nothing else.\n\nTask: {{title}}\n{{description}}\n\nAcceptance criteria:\n{{acceptance}}\n\nRelevant files:\n{{files}}\n\nTest requirements:\n{{tests}}\n\nKeep the change small. Do not refactor unrelated code. Tell me what you changed and how you verified it.',
  },
  {
    id: 'reviewer',
    label: 'Code reviewer',
    purpose: 'Reviews a change for regressions and checks it against the acceptance criteria. Read-only.',
    expectedOutput: 'A review: problems found (with file and line), acceptance criteria met or not, suggestions.',
    writeCapable: false,
    promptTemplate:
      'You are the code reviewer for the project "{{project}}". Review the current uncommitted changes. Do not change any file.\n\nTask under review: {{title}}\n\nAcceptance criteria:\n{{acceptance}}\n\nList regressions or bugs you can point to (file and line), say which acceptance criteria are met, and keep suggestions to what matters.',
  },
  {
    id: 'qa',
    label: 'QA and debugging',
    purpose: 'Reproduces defects, reads logs, prepares test cases and checks fixes where that is supported. Read-only.',
    expectedOutput: 'Reproduction steps or test cases, what was observed, and whether the fix holds.',
    writeCapable: false,
    promptTemplate:
      'You are the QA and debugging specialist for the project "{{project}}". Do not change any file.\n\nTask: {{title}}\n{{description}}\n\nTest requirements:\n{{tests}}\n\nReproduce the problem or prepare the test cases, report exactly what you observed, and say whether the acceptance criteria hold:\n{{acceptance}}',
  },
  {
    id: 'docs',
    label: 'Documentation',
    purpose: 'Prepares updates to handoff files, design documents, system descriptions and project notes. Read-only: it proposes text.',
    expectedOutput: 'Proposed document text for you to preview and approve before anything is saved.',
    writeCapable: false,
    promptTemplate:
      'You are the documentation specialist for the project "{{project}}". Propose text only; do not change any file.\n\nTask: {{title}}\n{{description}}\n\nRelevant files:\n{{files}}\n\nWrite concise, accurate text based on what the project actually contains. Mark anything you could not confirm.',
  },
  {
    id: 'assets',
    label: 'Asset and level-design assistant',
    purpose: 'Prepares asset briefs, naming standards, set-dressing plans, material specs, lighting checklists and integration instructions. Read-only.',
    expectedOutput: 'Briefs and checklists as text; no asset is created, moved or renamed.',
    writeCapable: false,
    promptTemplate:
      'You are the asset and level-design assistant for the project "{{project}}". Produce briefs and checklists only; do not change, move or rename any file.\n\nTask: {{title}}\n{{description}}\n\nAcceptance criteria:\n{{acceptance}}\n\nRelevant files:\n{{files}}',
  },
];

export const roleById = (id: string): AgentRole | undefined => AGENT_ROLES.find((role) => role.id === id);

/** Fills a role's prompt template from a task. Only task fields and the project name are used; no file is read. */
export function renderPrompt(role: AgentRole, task: Pick<Task, 'title' | 'description' | 'acceptance' | 'files' | 'testRequirements'>, projectName: string): string {
  const list = (items: readonly string[]): string => (items.length === 0 ? '(none given)' : items.map((item) => `- ${item}`).join('\n'));
  const values: Record<string, string> = {
    project: projectName,
    title: task.title,
    description: task.description.trim() === '' ? '(no description)' : task.description.trim(),
    acceptance: list(task.acceptance),
    files: list(task.files),
    tests: task.testRequirements.trim() === '' ? '(none given)' : task.testRequirements.trim(),
  };
  return role.promptTemplate.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');
}

// ---------------------------------------------------------------------------------------------------- run states

export const RUN_STATES = ['queued', 'planning', 'awaiting-approval', 'running', 'awaiting-review', 'testing', 'completed', 'failed', 'cancelled'] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_STATE_LABELS: Record<RunState, string> = {
  queued: 'Queued',
  planning: 'Planning',
  'awaiting-approval': 'Awaiting approval',
  running: 'Running',
  'awaiting-review': 'Awaiting review',
  testing: 'Testing',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** The visible orchestration states of spec §11 and the moves between them. Completed, failed and cancelled are final. */
export const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ['planning', 'running', 'cancelled'],
  planning: ['awaiting-approval', 'completed', 'failed', 'cancelled'],
  'awaiting-approval': ['planning', 'running', 'cancelled'],
  running: ['awaiting-review', 'testing', 'completed', 'failed', 'cancelled'],
  'awaiting-review': ['running', 'testing', 'completed', 'failed', 'cancelled'],
  testing: ['awaiting-review', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};
export const FINAL_RUN_STATES: readonly RunState[] = ['completed', 'failed', 'cancelled'];

// ---------------------------------------------------------------------------------------------------- workflows

export const WORKFLOW_IDS = ['plan', 'implement', 'documentation', 'assets'] as const;
export type WorkflowId = (typeof WORKFLOW_IDS)[number];

export interface WorkflowStep {
  /** `approval` is the person approving the plan; it is not a run. */
  kind: 'agent' | 'approval';
  role?: AgentRoleId;
  /** Off unless the person switches it on; never added automatically (spec §11: multiple paid calls are not free). */
  optional: boolean;
  action: string;
}

export interface WorkflowTemplate {
  id: WorkflowId;
  label: string;
  description: string;
  steps: readonly WorkflowStep[];
}

export const WORKFLOWS: readonly WorkflowTemplate[] = [
  {
    id: 'plan',
    label: 'Plan only',
    description: 'A read-only planner looks at the task and proposes a plan. Nothing is changed.',
    steps: [{ kind: 'agent', role: 'planner', optional: false, action: 'Read the project and write a plan for this task.' }],
  },
  {
    id: 'implement',
    label: 'Plan, approve, implement',
    description: 'Plan first, you approve the plan, then the implementer makes the change. A reviewer and a tester can be added, but only if you choose them.',
    steps: [
      { kind: 'agent', role: 'planner', optional: false, action: 'Read the project and write a plan for this task.' },
      { kind: 'approval', optional: false, action: 'You review the plan and approve it. The implementer cannot start without it.' },
      { kind: 'agent', role: 'implementer', optional: false, action: 'Change the project files to implement the approved plan (the only step that writes).' },
      { kind: 'agent', role: 'reviewer', optional: true, action: 'Review the change against the acceptance criteria (read-only).' },
      { kind: 'agent', role: 'qa', optional: true, action: 'Check the change against the test requirements (read-only).' },
    ],
  },
  {
    id: 'documentation',
    label: 'Documentation',
    description: 'A documentation specialist proposes text for you to preview. Nothing is saved without your approval.',
    steps: [{ kind: 'agent', role: 'docs', optional: false, action: 'Propose document text for this task (read-only).' }],
  },
  {
    id: 'assets',
    label: 'Asset or level brief',
    description: 'An assistant writes a brief or checklist. No asset is created, moved or renamed.',
    steps: [{ kind: 'agent', role: 'assets', optional: false, action: 'Write the brief or checklist for this task (read-only).' }],
  },
];

export const workflowById = (id: string): WorkflowTemplate | undefined => WORKFLOWS.find((workflow) => workflow.id === id);

// ---------------------------------------------------------------------------------------------------- schemas

const id = z.string().min(1).max(64);

export const AgentRoleSchema = z.object({
  id: z.enum(AGENT_ROLE_IDS),
  label: z.string().max(80),
  purpose: z.string().max(400),
  expectedOutput: z.string().max(300),
  writeCapable: z.boolean(),
});

export const WorkflowRequestSchema = z.strictObject({
  taskId: id,
  workflow: z.enum(WORKFLOW_IDS),
  includeReviewer: z.boolean(),
  includeQa: z.boolean(),
});
export type WorkflowRequest = z.input<typeof WorkflowRequestSchema>;

export const WorkflowStepViewSchema = z.object({
  kind: z.enum(['agent', 'approval']),
  role: z.enum(AGENT_ROLE_IDS).optional(),
  roleLabel: z.string().max(80).optional(),
  optional: z.boolean(),
  included: z.boolean(),
  writeCapable: z.boolean(),
  action: z.string().max(300),
  /** The provider the task names, or empty when none is chosen yet. */
  provider: z.string().max(80),
  usage: z.string().max(40),
  /** Why this step cannot run yet, such as a missing plan approval. Empty when nothing stands in the way. */
  blockedBy: z.string().max(300),
});
export type WorkflowStepView = z.output<typeof WorkflowStepViewSchema>;

export const WorkflowPreviewSchema = z.object({
  workflow: z.enum(WORKFLOW_IDS),
  label: z.string().max(80),
  description: z.string().max(400),
  steps: z.array(WorkflowStepViewSchema).max(10),
  /** Always true until Step 15: read-only runs can start from the queue, runs that change project files cannot. */
  writesUnavailable: z.literal(true),
});
export type WorkflowPreview = z.output<typeof WorkflowPreviewSchema>;

export const RunSchema = z.object({
  id,
  projectId: id,
  taskId: id.nullable(),
  workflowId: id.nullable(),
  stepIndex: z.number().int().nonnegative(),
  role: z.enum(AGENT_ROLE_IDS),
  providerId: z.string().max(80),
  state: z.enum(RUN_STATES),
  writeCapable: z.boolean(),
  optional: z.boolean(),
  note: z.string().max(1000),
  allowedNext: z.array(z.enum(RUN_STATES)).max(9),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Queue order (Step 13): higher first, then the earliest request. Starts as the task's priority. */
  priority: z.enum(PRIORITIES),
  model: z.string().max(200),
  /** 1 for the first try; a retry is a new run with the next number, up to `routing.maxAttempts`. */
  attempt: z.number().int().min(1).max(10),
  retryOf: id.nullable(),
  /** The routing decision of the last start, with its reasons and cost note. */
  route: RouteSchema.nullable(),
  /** What the provider answered (capped). Empty until a run finished with an answer. */
  result: z.string().max(200_000),
  /** When the person asked the queue to start it; null when it is not waiting to start. */
  requestedAt: z.iso.datetime().nullable(),
  /** Why a requested run is waiting (a busy provider, the writer lock, the local-inference policy). Empty when it is not held. */
  hold: z.string().max(600),
});
export type AgentRun = z.output<typeof RunSchema>;

export const QueueEntrySchema = RunSchema.extend({ taskTitle: z.string().max(200) });
export type QueueEntry = z.output<typeof QueueEntrySchema>;

export const WriterLockSchema = z.object({
  runId: id,
  role: z.string().max(80),
  acquiredAt: z.iso.datetime(),
  /** The run that holds it is running now. False after a restart: the app could not see that writer end. */
  active: z.boolean(),
});

export const QueueViewSchema = z.object({
  /** Running and waiting runs first (in the order they will start), then queued ones, then the 20 most recent finished runs. */
  runs: z.array(QueueEntrySchema).max(500),
  lock: WriterLockSchema.nullable(),
  /** Until Step 15 no run may change project files (CLAUDE.md, "Rules that span steps"). */
  writesEnabled: z.boolean(),
  maxAttempts: z.number().int().min(1).max(10),
});
export type QueueView = z.output<typeof QueueViewSchema>;

export const PromptPreviewSchema = z.object({
  role: z.enum(AGENT_ROLE_IDS),
  writeCapable: z.boolean(),
  prompt: z.string().max(40_000),
  /** What the preview is and is not. */
  note: z.string().max(300),
});
