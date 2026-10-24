import { renameSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { AppError } from '@shared/errors';
import type {
  BackupItem,
  ExportResult,
  ImportConflictMode,
  ImportPreview,
  ImportResult,
  StorageStatus,
} from '@shared/storage';
import type { ActivityLog, Logger } from '../logging';
import type { BackupInfo, BackupService } from './backups';
import type { Db } from './db';
import { resolveBackup, stageRestore } from './restore';
import { MAX_IMPORT_BYTES, type ParsedImport, type Row, type Transfer } from './transfer';

// What the Data and backups section asks main to do (spec §22, §27.6). Every file or folder choice goes through a native
// dialog opened by main (`StorageUi`), and anything that overwrites data or registers a project folder is confirmed there
// too, so the page can only ask; it can never name a path.

export interface StorageUi {
  confirm(options: { title: string; message: string; detail?: string; confirmLabel: string }): Promise<boolean>;
  /** Save dialog; undefined when cancelled. */
  chooseExportFile(defaultName: string): Promise<string | undefined>;
  /** Open dialog; undefined when cancelled. */
  chooseImportFile(): Promise<string | undefined>;
  /** Starts the app again after it quits, so a staged restore is applied. */
  relaunch(): void;
}

export interface StorageService {
  status(): StorageStatus;
  backupNow(): Promise<BackupItem>;
  /** Asks for confirmation, backs up the current data, stages the restore and restarts. */
  restore(backupId: string): Promise<{ staged: boolean }>;
  exportData(): Promise<ExportResult>;
  previewImport(): Promise<ImportPreview>;
  applyImport(mode: ImportConflictMode): Promise<ImportResult>;
}

export interface StorageServiceOptions {
  db: Db;
  userDataDir: string;
  backups: BackupService;
  transfer: Transfer;
  activity: ActivityLog;
  logger: Logger;
  ui: StorageUi;
  /** The schema version this build knows. */
  schemaVersion: () => number;
  /** Reads settings from the database again after an import. */
  reloadSettings: () => void;
  now?: () => Date;
}

const toItem = (info: BackupInfo): BackupItem => ({ id: basename(info.path), createdAt: info.createdAt, reason: info.reason, sizeBytes: info.sizeBytes });
const REASON_TEXT = { 'pre-migration': 'before an update', manual: 'manual', scheduled: 'scheduled', 'pre-restore': 'before a restore', 'pre-import': 'before an import' } as const;

export function createStorageService(options: StorageServiceOptions): StorageService {
  const { db, userDataDir, backups, transfer, activity, logger, ui } = options;
  const now = options.now ?? (() => new Date());
  let staged: { parsed: ParsedImport; fileName: string } | undefined;

  return {
    status() {
      const list = backups.list().map(toItem);
      return {
        schemaVersion: options.schemaVersion(),
        databaseBytes: statSync(db.path).size,
        backups: list,
        lastScheduledAt: list.find((b) => b.reason === 'scheduled')?.createdAt ?? null,
      };
    },

    async backupNow() {
      const info = await backups.create('manual');
      activity.record({ kind: 'backup.created', severity: 'info', summary: 'Made a backup of the app data (manual).', details: { file: basename(info.path), sizeBytes: info.sizeBytes } });
      return toItem(info);
    },

    async restore(backupId) {
      resolveBackup(userDataDir, backupId, options.schemaVersion()); // refuses a name that is not a usable backup before asking anything
      const chosen = backups.list().find((b) => basename(b.path) === backupId);
      const confirmed = await ui.confirm({
        title: 'Restore this backup?',
        message: `Restore the backup from ${chosen?.createdAt ?? backupId} (${chosen === undefined ? 'backup' : REASON_TEXT[chosen.reason]})?`,
        detail:
          'Your current app data is backed up first. The app then restarts with the restored data. Settings, projects, activity and everything else stored by the app go back to how they were at that time. Your project folders are not touched.',
        confirmLabel: 'Restore and restart',
      });
      if (!confirmed) return { staged: false };
      const before = await backups.create('pre-restore');
      stageRestore({ userDataDir, backupId, knownSchemaVersion: options.schemaVersion(), now });
      activity.record({
        kind: 'backup.restore-staged',
        severity: 'warning',
        summary: 'Restoring a backup: the current data was saved first and the app is restarting.',
        details: { restoreFrom: backupId, savedAs: basename(before.path) },
      });
      logger.info('restore staged', { backupId, savedAs: basename(before.path) });
      ui.relaunch();
      return { staged: true };
    },

    async exportData() {
      const stamp = now().toISOString().slice(0, 10);
      const target = await ui.chooseExportFile(`gdcc-export-${stamp}.json`);
      const { file, counts } = transfer.export();
      if (target === undefined) return { saved: false, tables: counts };
      const temporary = `${target}.tmp`;
      writeFileSync(temporary, JSON.stringify(file, null, 2), 'utf8');
      renameSync(temporary, target);
      activity.record({ kind: 'data.exported', severity: 'info', summary: `Exported ${counts.reduce((n, c) => n + c.rows, 0).toLocaleString('en-US')} rows to ${basename(target)}.`, details: { tables: counts } });
      return { saved: true, tables: counts };
    },

    async previewImport() {
      staged = undefined;
      const source = await ui.chooseImportFile();
      if (source === undefined) return { staged: false, tables: [], projectFolders: [], warnings: [] };
      let size: number;
      try {
        size = statSync(source).size;
      } catch (error) {
        throw new AppError('NOT_FOUND', 'That file could not be opened.', { hint: 'Choose the file again.', cause: error });
      }
      if (size > MAX_IMPORT_BYTES) throw new AppError('LIMIT_REACHED', 'That file is too large to be an export from this app.', { hint: 'Choose a file that was exported by this app.' });
      const parsed = transfer.parse(readFileSync(source, 'utf8'));
      const preview = transfer.preview(parsed);
      staged = { parsed, fileName: basename(source) };
      return {
        staged: true,
        fileName: basename(source),
        exportedAt: parsed.file.exportedAt,
        appVersion: parsed.file.appVersion,
        tables: preview.tables,
        projectFolders: confirmations(preview.newRows).slice(0, 500),
        warnings: parsed.warnings.slice(0, 20),
      };
    },

    async applyImport(mode) {
      if (staged === undefined) throw new AppError('INVALID_INPUT', 'Choose a file to import first.', { hint: 'Use "Choose a file to import…" and check the preview.' });
      const { parsed, fileName } = staged;
      // Judge against the data as it is now, not as it was when the preview was made.
      const preview = transfer.preview(parsed);
      const replaced = mode === 'replace' ? preview.tables.reduce((n, t) => n + t.conflicts, 0) : 0;
      const folders = confirmations(mode === 'replace' ? [...preview.newRows, ...preview.conflictRows] : preview.newRows);
      const added = preview.tables.reduce((n, t) => n + t.added, 0);
      if (folders.length > 0 || replaced > 0) {
        const parts: string[] = [];
        if (replaced > 0) parts.push(`${replaced} existing item(s) will be overwritten by the file's version.`);
        if (folders.length > 0) parts.push(`These project folders will be added (the app will only read them):\n${folders.slice(0, 15).join('\n')}${folders.length > 15 ? `\nand ${folders.length - 15} more` : ''}`);
        const ok = await ui.confirm({ title: 'Apply this import?', message: `Import ${added} new item(s) from ${fileName}?`, detail: `${parts.join('\n\n')}\n\nThe current data is backed up first.`, confirmLabel: 'Import' });
        if (!ok) return { applied: false, tables: [] };
      }
      const before = await backups.create('pre-import');
      const tables = transfer.apply(parsed, mode);
      options.reloadSettings();
      staged = undefined;
      const sum = (pick: (t: ImportResult['tables'][number]) => number): number => tables.reduce((n, t) => n + pick(t), 0);
      activity.record({
        kind: 'data.imported',
        severity: 'info',
        summary: `Imported ${fileName}: ${sum((t) => t.added)} added, ${sum((t) => t.replaced)} replaced, ${sum((t) => t.skipped)} skipped.`,
        details: { tables, savedAs: basename(before.path), mode },
      });
      return { applied: true, tables };
    },
  };

  function confirmations(rows: { table: { needsConfirmation?(row: Row): string | undefined }; row: Row }[]): string[] {
    return rows.flatMap(({ table, row }) => {
      const text = table.needsConfirmation?.(row);
      return text === undefined ? [] : [text];
    });
  }
}
