import { z } from 'zod';

// Scoped permissions (spec §14). Everything starts read-only. Three further scopes exist and none can be granted by the page, an
// agent or a file: a grant is made only by a person answering a native window in the main process.
//  - project-writes: agents may change files in this project (per project, or per task). Every writing run is still confirmed.
//  - commands: the per-project list of commands you approved one by one; the app runs only those. Agents get no command access.
//  - destructive: a single operation (a recursive delete, a history rewrite) approved one at a time; it is never a lasting grant.
// Only project-writes is a lasting grant (a row in `permissions`); the other two are recorded as approvals.

export const PERMISSION_SCOPES = ['project-writes'] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];
export const APPROVAL_SCOPES = ['project-writes', 'commands', 'destructive'] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

export const SCOPE_LABELS: Record<ApprovalScope, string> = {
  'project-writes': 'Approved project writes',
  commands: 'Approved commands',
  destructive: 'Destructive operation',
};
export const SCOPE_ABOUT: Record<PermissionScope, string> = {
  'project-writes': 'Agents may change files in this folder. Each writing run still asks you first, shows the Git state and makes a checkpoint.',
};

export const PermissionSchema = z.object({
  id: z.string().max(64),
  projectId: z.string().max(64),
  /** null: the whole project. */
  taskId: z.string().max(64).nullable(),
  taskTitle: z.string().max(200).nullable(),
  scope: z.enum(PERMISSION_SCOPES),
  what: z.string().max(300),
  /** The folder it applies to, as it was when you granted it. */
  where: z.string().max(500),
  grantedAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type Permission = z.output<typeof PermissionSchema>;

export const ApprovalSchema = z.object({
  id: z.string().max(64),
  projectId: z.string().max(64),
  taskId: z.string().max(64).nullable(),
  runId: z.string().max(64).nullable(),
  scope: z.enum(APPROVAL_SCOPES),
  what: z.string().max(300),
  where: z.string().max(500),
  detail: z.string().max(2000),
  at: z.iso.datetime(),
});
export type Approval = z.output<typeof ApprovalSchema>;

/** A command found in the project and whether you approved it. Only package.json scripts are discovered so far. */
export const ProjectCommandSchema = z.object({
  /** For example `npm run test`. */
  label: z.string().max(200),
  /** The program and arguments that would run; never a shell string. */
  argv: z.array(z.string().max(200)).max(10),
  /** What the script does, as written in the project, redacted. */
  body: z.string().max(500),
  /** Why it looks destructive; empty when nothing matched. */
  risks: z.array(z.string().max(200)).max(10),
  approval: z
    .object({
      id: z.string().max(64),
      approvedAt: z.iso.datetime(),
      destructive: z.boolean(),
      /** The script text differs from what you approved, so it will not run until you approve it again. */
      changed: z.boolean(),
    })
    .nullable(),
});
export type ProjectCommand = z.output<typeof ProjectCommandSchema>;

export const PermissionsViewSchema = z.object({
  grants: z.array(PermissionSchema).max(200),
  approvals: z.array(ApprovalSchema).max(50),
  commands: z.array(ProjectCommandSchema).max(100),
  /** Why commands are not listed (no package.json, unreadable), empty otherwise. */
  commandsNote: z.string().max(300),
});
export type PermissionsView = z.output<typeof PermissionsViewSchema>;

export const CommandResultSchema = z.object({
  /** False when you declined the confirmation; nothing ran. */
  ran: z.boolean(),
  status: z.enum(['exited', 'timed-out', 'cancelled', 'output-limit', 'spawn-failed']).nullable(),
  exitCode: z.number().int().nullable(),
  /** The end of the output with secrets removed. */
  output: z.string().max(20_000),
  truncated: z.boolean(),
});
export type CommandResult = z.output<typeof CommandResultSchema>;
