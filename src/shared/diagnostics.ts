import { z } from 'zod';
import { ACTIVITY_SEVERITIES } from './activity';

// Activity search and export, the log viewer and the diagnostics bundle (spec §15, §22, §27.8). Everything that leaves main for a file
// or for the page has been through the redactor.

export const ActivityQuerySchema = z.strictObject({
  projectId: z.string().max(64).optional(),
  kinds: z.array(z.string().min(1).max(100)).max(20).optional(),
  severities: z.array(z.enum(ACTIVITY_SEVERITIES)).max(3).optional(),
  /** Matches the summary and the kind, any case. */
  search: z.string().max(100).optional(),
  /** Only events at or after this time. */
  since: z.iso.datetime().optional(),
  before: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(500).default(50),
});
export type ActivityQuery = z.input<typeof ActivityQuerySchema>;

export const ActivityExportRequestSchema = z.strictObject({
  format: z.enum(['json', 'csv']),
  projectId: z.string().max(64).optional(),
  kinds: z.array(z.string().min(1).max(100)).max(20).optional(),
  severities: z.array(z.enum(ACTIVITY_SEVERITIES)).max(3).optional(),
  search: z.string().max(100).optional(),
  since: z.iso.datetime().optional(),
});

export const LOG_LEVEL_NAMES = ['error', 'warn', 'info', 'debug'] as const;
export const LogEntrySchema = z.object({
  at: z.string().max(40),
  level: z.enum(LOG_LEVEL_NAMES),
  module: z.string().max(120),
  message: z.string().max(1000),
  /** The structured data of the entry as text, redacted. */
  data: z.string().max(2000),
});
export type LogEntry = z.output<typeof LogEntrySchema>;

export const LogsRequestSchema = z.strictObject({
  lines: z.number().int().min(1).max(1000).default(200),
  /** Only this level and the more serious ones. */
  level: z.enum(LOG_LEVEL_NAMES).optional(),
  search: z.string().max(100).optional(),
});

export const LogsResultSchema = z.object({
  entries: z.array(LogEntrySchema).max(1000),
  /** The files the lines came from, newest first, and their sizes. */
  files: z.array(z.object({ name: z.string().max(60), bytes: z.number().int().nonnegative() })).max(20),
});
export type LogsResult = z.output<typeof LogsResultSchema>;

export const FileExportResultSchema = z.object({
  /** False when the person cancelled the save window. */
  saved: z.boolean(),
  count: z.number().int().nonnegative(),
});
