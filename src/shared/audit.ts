import { z } from 'zod';

// The audit report (spec §7): what was found in a registered project, with every statement marked Confirmed (a file proves
// it) or Inferred (a reasonable reading of what was found). A confirmed finding must name at least one file.

export const AuditEvidenceSchema = z.object({
  /** Project-relative path of the file that proves or suggests the finding. */
  path: z.string().max(400),
  line: z.number().int().positive().optional(),
  detail: z.string().max(300).optional(),
});
export type AuditEvidence = z.output<typeof AuditEvidenceSchema>;

export const FindingSchema = z
  .object({
    kind: z.enum(['confirmed', 'inferred']),
    title: z.string().max(400),
    detail: z.string().max(1500).optional(),
    severity: z.enum(['info', 'warning']).optional(),
    evidence: z.array(AuditEvidenceSchema).max(40),
  })
  .refine((finding) => finding.kind !== 'confirmed' || finding.evidence.length > 0, {
    message: 'A confirmed finding needs at least one piece of evidence.',
  });
export type Finding = z.output<typeof FindingSchema>;

export const SECTION_IDS = [
  'overview',
  'engine',
  'languages',
  'structure',
  'entry-points',
  'documentation',
  'commands',
  'assets',
  'git',
  'unfinished',
  'relationships',
  'duplicates',
  'risks',
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export const AuditSectionSchema = z.object({
  id: z.enum(SECTION_IDS),
  title: z.string().max(100),
  summary: z.string().max(600),
  findings: z.array(FindingSchema).max(300),
});
export type AuditSection = z.output<typeof AuditSectionSchema>;

export const GitSummarySchema = z.object({
  /** False when Git is not installed or could not be run. */
  available: z.boolean(),
  isRepository: z.boolean(),
  /** Why Git could not answer, in plain words. */
  message: z.string().max(500).optional(),
  branch: z.string().max(200).optional(),
  upstream: z.string().max(200).optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  changes: z
    .object({
      staged: z.number().int().nonnegative(),
      modified: z.number().int().nonnegative(),
      untracked: z.number().int().nonnegative(),
      conflicted: z.number().int().nonnegative(),
    })
    .optional(),
  recentCommits: z
    .array(z.object({ hash: z.string().max(64), author: z.string().max(200), date: z.string().max(40), subject: z.string().max(300) }))
    .max(30)
    .optional(),
});
export type GitSummary = z.output<typeof GitSummarySchema>;

export const ScanStatsSchema = z.object({
  files: z.number().int().nonnegative(),
  directories: z.number().int().nonnegative(),
  bytes: z.number().nonnegative(),
  skippedHeavyDirs: z.array(z.string().max(300)).max(200),
  sensitiveFilesSkipped: z.number().int().nonnegative(),
  linksSkipped: z.number().int().nonnegative(),
  /** Limits that stopped the scan early; empty when everything inside the folder was looked at. */
  truncated: z.array(z.enum(['files', 'depth', 'time'])),
  elapsedMs: z.number().nonnegative(),
});
export type ScanStats = z.output<typeof ScanStatsSchema>;

export const AuditReportSchema = z.object({
  id: z.string().max(64),
  projectId: z.string().max(64),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  scan: ScanStatsSchema,
  git: GitSummarySchema,
  sections: z.array(AuditSectionSchema).max(20),
});
export type AuditReport = z.output<typeof AuditReportSchema>;

export const AuditSummarySchema = z.object({
  id: z.string().max(64),
  projectId: z.string().max(64),
  finishedAt: z.iso.datetime(),
  files: z.number().int().nonnegative(),
});
export type AuditSummary = z.output<typeof AuditSummarySchema>;
