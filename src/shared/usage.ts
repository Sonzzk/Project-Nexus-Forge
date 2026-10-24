import { z } from 'zod';
import { GENERATE_PURPOSES, PROVIDER_IDS } from './providers';

// The local usage log and launch limits (spec §12). A row is written when a request is really sent (and when a limit
// stops one). Token counts and cost are stored only when the provider returned them; missing stays empty and is shown as
// "Unavailable from this provider", never as zero. A cost is the provider's own client-side estimate, not a charge.

export const USAGE_STATUSES = ['running', 'completed', 'failed', 'cancelled', 'blocked', 'interrupted'] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];
export const USAGE_STATUS_LABELS: Record<UsageStatus, string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  blocked: 'Blocked by a limit',
  interrupted: 'Interrupted by a restart',
};

export const USAGE_UNAVAILABLE = 'Unavailable from this provider';

export const UsageRowSchema = z.object({
  id: z.string().max(64),
  projectId: z.string().max(64).nullable(),
  projectName: z.string().max(200).nullable(),
  taskId: z.string().max(64).nullable(),
  taskTitle: z.string().max(200).nullable(),
  runId: z.string().max(64).nullable(),
  purpose: z.enum(GENERATE_PURPOSES),
  provider: z.enum(PROVIDER_IDS),
  /** Empty when the provider chose its own default and did not say which. */
  model: z.string().max(200),
  /** `cloud` for anything that leaves this PC. */
  location: z.enum(['local', 'cloud']),
  status: z.enum(USAGE_STATUSES),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  inputCount: z.number().int().nonnegative().nullable(),
  outputCount: z.number().int().nonnegative().nullable(),
  costUsdEstimate: z.number().nonnegative().nullable(),
  /** Why it failed, was cancelled or was blocked. */
  reason: z.string().max(600),
});
export type UsageRow = z.output<typeof UsageRowSchema>;

/** Totals over one span of time. A total covers only the runs that reported; `null` means none did. */
export const UsageWindowSchema = z.object({
  /** Requests that were really sent (blocked ones are not). */
  launches: z.number().int().nonnegative(),
  cloudLaunches: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  /** Sent requests that returned token counts or a cost, and those that did not. */
  reported: z.number().int().nonnegative(),
  unreported: z.number().int().nonnegative(),
  inputCount: z.number().int().nonnegative().nullable(),
  outputCount: z.number().int().nonnegative().nullable(),
  costUsdEstimate: z.number().nonnegative().nullable(),
});
export type UsageWindow = z.output<typeof UsageWindowSchema>;

export const LimitStateSchema = z.object({
  /** 0 means no limit. */
  limit: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
});
export type LimitState = z.output<typeof LimitStateSchema>;

export const UsageSummarySchema = z.object({
  today: UsageWindowSchema,
  last30Days: UsageWindowSchema,
  byProvider: z.array(z.object({ provider: z.enum(PROVIDER_IDS), launches: z.number().int().nonnegative(), reported: z.number().int().nonnegative(), unreported: z.number().int().nonnegative() })),
  limits: z.object({
    perDay: LimitStateSchema,
    /** Launches today in the chosen project; null when no project was asked about. */
    perProject: LimitStateSchema.nullable(),
    /** Launches ever made for one task; shown per task, so only its limit is given. */
    perTaskLimit: z.number().int().nonnegative(),
    /** The attempts a run may have (the routing setting); retries beyond it are refused. */
    maxAttempts: z.number().int().positive(),
  }),
  /** The span `today` covers, so the page can say which day it is. */
  dayStartsAt: z.iso.datetime(),
});
export type UsageSummary = z.output<typeof UsageSummarySchema>;

export const UsageListRequestSchema = z.strictObject({
  projectId: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
