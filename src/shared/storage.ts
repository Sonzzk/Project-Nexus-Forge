import { z } from 'zod';

// What the Data and backups section shows (spec §22, §27.6). Backups are addressed by file name, never by path; the
// folders for export, import and restore are chosen in native dialogs opened by main.

export const BACKUP_REASONS = ['pre-migration', 'manual', 'scheduled', 'pre-restore', 'pre-import'] as const;
export type BackupReasonName = (typeof BACKUP_REASONS)[number];

export const BackupItemSchema = z.object({
  /** The backup's file name; the only way to refer to it. */
  id: z.string().max(200),
  createdAt: z.iso.datetime(),
  reason: z.enum(BACKUP_REASONS),
  sizeBytes: z.number().nonnegative(),
});
export type BackupItem = z.output<typeof BackupItemSchema>;

export const StorageStatusSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  databaseBytes: z.number().nonnegative(),
  backups: z.array(BackupItemSchema),
  /** Time of the newest scheduled backup, if any. */
  lastScheduledAt: z.iso.datetime().nullable(),
});
export type StorageStatus = z.output<typeof StorageStatusSchema>;

export const ExportResultSchema = z.object({
  /** False when the user cancelled the save dialog. */
  saved: z.boolean(),
  /** Rows written per table. */
  tables: z.array(z.object({ id: z.string().max(60), label: z.string().max(100), rows: z.number().int().nonnegative() })),
});
export type ExportResult = z.output<typeof ExportResultSchema>;

export const TablePreviewSchema = z.object({
  id: z.string().max(60),
  label: z.string().max(100),
  /** Rows in the file. */
  total: z.number().int().nonnegative(),
  /** Not in the app yet; will be added. */
  added: z.number().int().nonnegative(),
  /** Already in the app, identical; nothing to do. */
  same: z.number().int().nonnegative(),
  /** Same key as a row in the app but different content; kept unless the user chooses to replace. */
  conflicts: z.number().int().nonnegative(),
  /** Cannot be imported: clashes with another row's unique value, or its parent row is missing. Never replaced. */
  blocked: z.number().int().nonnegative(),
});
export type TablePreview = z.output<typeof TablePreviewSchema>;

export const ImportPreviewSchema = z.object({
  /** False when the user cancelled the open dialog. */
  staged: z.boolean(),
  fileName: z.string().max(260).optional(),
  exportedAt: z.string().max(40).optional(),
  appVersion: z.string().max(40).optional(),
  tables: z.array(TablePreviewSchema),
  /** Folders that new projects would register; the user confirms these in a dialog before anything is applied. */
  projectFolders: z.array(z.string().max(1000)).max(500),
  warnings: z.array(z.string().max(300)).max(20),
});
export type ImportPreview = z.output<typeof ImportPreviewSchema>;

export const IMPORT_CONFLICT_MODES = ['skip', 'replace'] as const;
export type ImportConflictMode = (typeof IMPORT_CONFLICT_MODES)[number];

export const ImportResultSchema = z.object({
  /** False when the user declined the confirmation; nothing was changed. */
  applied: z.boolean(),
  tables: z.array(
    z.object({
      id: z.string().max(60),
      label: z.string().max(100),
      added: z.number().int().nonnegative(),
      replaced: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
    }),
  ),
});
export type ImportResult = z.output<typeof ImportResultSchema>;
