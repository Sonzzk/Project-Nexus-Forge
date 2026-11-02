import { z } from 'zod';

// Reviewing what an agent changed (spec §14). A session starts when a writing run is approved: the app records the state of the
// project at that moment (a Git commit that holds even uncommitted tracked changes) and what was untracked. The session's files are
// whatever differs from that record now, so the person's own earlier uncommitted work is never counted as the agent's.

export const SESSION_STATUSES = ['open', 'approved', 'rejected'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = { open: 'To review', approved: 'Committed', rejected: 'Rejected' };

export const ChangeSessionSchema = z.object({
  id: z.string().max(64),
  projectId: z.string().max(64),
  taskId: z.string().max(64).nullable(),
  taskTitle: z.string().max(200).nullable(),
  runId: z.string().max(64),
  roleLabel: z.string().max(80),
  status: z.enum(SESSION_STATUSES),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** The commit made when the changes were approved. */
  commit: z.string().max(64).nullable(),
  /** The Git reference that holds the state before the run. */
  checkpointRef: z.string().max(300),
  /** The run that made the changes is still working, so the list can still change. */
  runActive: z.boolean(),
});
export type ChangeSession = z.output<typeof ChangeSessionSchema>;

export const ChangedFileSchema = z.object({
  path: z.string().max(400),
  status: z.enum(['added', 'modified', 'deleted', 'other']),
  binary: z.boolean(),
  sizeBefore: z.number().int().nonnegative().nullable(),
  sizeAfter: z.number().int().nonnegative().nullable(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** The file could hold secrets, so its content is not shown and it is never committed from here. */
  hidden: z.boolean(),
  /** The file already had uncommitted changes of yours when the run started, so a commit would include them too. */
  overlap: z.boolean(),
  /** A unified diff, with secrets removed. Empty for binary, hidden and oversized files. */
  diff: z.string().max(220_000),
  /** Why there is no diff, or what to know about it. */
  note: z.string().max(300),
});
export type ChangedFile = z.output<typeof ChangedFileSchema>;

export const ReviewSchema = z.object({
  session: ChangeSessionSchema,
  files: z.array(ChangedFileSchema).max(300),
  /** Anything that makes the list incomplete or uncertain. */
  notes: z.array(z.string().max(300)).max(10),
});
export type Review = z.output<typeof ReviewSchema>;

export const CheckpointItemSchema = z.object({ name: z.string().max(100), ref: z.string().max(300), commit: z.string().max(64), at: z.string().max(40), subject: z.string().max(200) });
export const BranchItemSchema = z.object({ name: z.string().max(200), current: z.boolean(), upstream: z.string().max(200).nullable(), commit: z.string().max(64) });
export const WorktreeItemSchema = z.object({ id: z.string().max(64), name: z.string().max(100), path: z.string().max(500), branch: z.string().max(200), createdAt: z.iso.datetime(), present: z.boolean() });
export type WorktreeItem = z.output<typeof WorktreeItemSchema>;

/** What Git can and cannot protect in this project (spec §14: never assume a commit backs up large binaries). */
export const ProtectionSchema = z.object({
  lfs: z.boolean(),
  binaryFiles: z.number().int().nonnegative(),
  largestBinaryMb: z.number().nonnegative(),
  notes: z.array(z.string().max(400)).max(6),
});
export type Protection = z.output<typeof ProtectionSchema>;

export const GitOverviewSchema = z.object({
  branches: z.array(BranchItemSchema).max(200),
  checkpoints: z.array(CheckpointItemSchema).max(200),
  worktrees: z.array(WorktreeItemSchema).max(50),
  protection: ProtectionSchema,
  /** Why part of this could not be read (no Git, not a repository), empty otherwise. */
  note: z.string().max(300),
});
export type GitOverview = z.output<typeof GitOverviewSchema>;
