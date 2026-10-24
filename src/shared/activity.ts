import { z } from 'zod';

// The user-facing history of what happened (ARCHITECTURE.md section 11). The app log is for diagnostics; this is for the user.

export const ACTIVITY_SEVERITIES = ['info', 'warning', 'error'] as const;
export type ActivitySeverity = (typeof ACTIVITY_SEVERITIES)[number];

export const ActivityEventSchema = z.object({
  id: z.string().max(64),
  occurredAt: z.iso.datetime(),
  /** Dotted name such as `app.started` or `project.added`. */
  kind: z.string().min(1).max(100),
  severity: z.enum(ACTIVITY_SEVERITIES),
  summary: z.string().max(1000),
  projectId: z.string().max(64).optional(),
  taskId: z.string().max(64).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ActivityEvent = z.output<typeof ActivityEventSchema>;

export interface ActivityFilter {
  projectId?: string | undefined;
  kinds?: readonly string[] | undefined;
  /** Only events strictly older than this ISO time. */
  before?: string | undefined;
  limit: number;
}
