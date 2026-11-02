import { z } from 'zod';
import { RUN_STATES } from './agents';
import { PROVIDER_IDS, ToolUseSchema } from './providers';

// The live session view (spec §15). A session is one agent run that was really started. Every field is something the app observed:
// a state it recorded, an event the provider printed, a process it started. Whatever the provider does not expose is said to be
// not exposed, and the page never shows a state, a command or a thought that has no event behind it.

export const SESSION_OUTCOMES = ['running', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];
export const SESSION_OUTCOME_LABELS: Record<SessionOutcome, string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted by a restart',
};

export { ObservedSchema, ToolUseSchema, type Observed, type ToolUse } from './providers';

export const SessionSummarySchema = z.object({
  runId: z.string().max(64),
  projectId: z.string().max(64),
  roleLabel: z.string().max(80),
  taskTitle: z.string().max(200).nullable(),
  provider: z.enum(PROVIDER_IDS),
  model: z.string().max(200),
  outcome: z.enum(SESSION_OUTCOMES),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  elapsedMs: z.number().int().nonnegative(),
});
export type SessionSummary = z.output<typeof SessionSummarySchema>;

export const SessionSchema = SessionSummarySchema.extend({
  taskId: z.string().max(64).nullable(),
  /** The run's state in the workflow (queued, planning, running, ...), as recorded by the queue. */
  runState: z.enum(RUN_STATES),
  workingDir: z.string().max(500),
  exitCode: z.number().int().nullable(),
  providerSessionId: z.string().max(200).nullable(),
  denials: z.array(ToolUseSchema).max(100),
  tools: z.array(ToolUseSchema).max(200),
  error: z.string().max(1500),
  /** The answer so far, or the whole answer once the run ended, with secrets removed. */
  output: z.string().max(40_000),
  outputTruncated: z.boolean(),
  /** The provider sent its answer piece by piece, so what is shown while it runs was really streamed. */
  streamed: z.boolean(),
  /** The first lines of the answer, once there is one. */
  summary: z.string().max(400),
  /** Events the app recorded about this run, newest first. */
  recent: z.array(z.object({ at: z.iso.datetime(), summary: z.string().max(500) })).max(20),
  /** Programs the app started for this run (the provider's own command line, not what the agent ran inside it). */
  processes: z.array(z.object({ purpose: z.string().max(200), program: z.string().max(100), status: z.string().max(30), exitCode: z.number().int().nullable(), startedAt: z.iso.datetime(), endedAt: z.iso.datetime().nullable() })).max(10),
  /** The review session that holds this run's changed files, if the run could change files. */
  reviewSessionId: z.string().max(64).nullable(),
  /** What this provider does and does not tell the app. */
  exposes: z.object({ streaming: z.boolean(), toolEvents: z.boolean(), denials: z.boolean(), exitCode: z.boolean(), sessionId: z.boolean() }),
  /** Whether and how the provider documents resuming, and the id to use. The app does not resume runs itself. */
  resume: z.object({ documented: z.boolean(), how: z.string().max(300) }),
  notes: z.array(z.string().max(300)).max(8),
});
export type Session = z.output<typeof SessionSchema>;

export const AttentionItemSchema = z.object({
  id: z.string().max(100),
  severity: z.enum(['info', 'warning']),
  text: z.string().max(400),
  /** The page that deals with it. */
  section: z.enum(['workbench', 'git', 'activity', 'integrations', 'tasks']),
  projectId: z.string().max(64).optional(),
});
export type AttentionItem = z.output<typeof AttentionItemSchema>;
