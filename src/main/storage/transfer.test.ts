import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import type { ImportConflictMode } from '@shared/storage';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { copyFixture } from '../../../test/helpers/tree';
import { createActivityLog, createRedactor } from '../logging';
import { activityTable } from '../logging/export';
import { createProjectRegistry, projectTables } from '../projects';
import { createSettingsStore } from '../settings';
import { settingsTable } from '../settings/export';
import { createBackupService, type BackupService } from './backups';
import type { Db } from './db';
import { createStorageService, type StorageUi } from './service';
import { createTransfer, type ExportFile, type Transfer } from './transfer';

afterEach(removeTempDirs);

async function app() {
  const { db, dir } = await openMigratedDb();
  const logger = memoryLogger();
  const activity = createActivityLog({ db, redactor: createRedactor(), logger });
  const settings = createSettingsStore({ db, logger, activity });
  const projects = createProjectRegistry({ db, activity, logger });
  const transfer = createTransfer({ db, appVersion: 'test', schemaVersion: () => 3 });
  for (const table of [settingsTable, ...projectTables, activityTable]) transfer.register(table);
  return { db, dir, logger, activity, settings, projects, transfer };
}

/** Every registered table as plain rows, for comparing two databases. */
const dump = (db: Db, transfer: Transfer): Record<string, unknown[]> =>
  Object.fromEntries(transfer.tables().map((t) => [t.id, db.all(`SELECT * FROM "${t.id}" ORDER BY ${t.orderBy ?? t.key.join(', ')}`)]));

const codeOf = (fn: () => unknown): { code?: string; message?: string } => {
  try {
    fn();
    return {};
  } catch (error) {
    return { code: (error as AppError).code, message: (error as AppError).message };
  }
};

/** The export file as text, ready to be edited into something hostile. */
const exported = (transfer: Transfer): ExportFile => JSON.parse(JSON.stringify(transfer.export().file)) as ExportFile;

describe('export and import round trip', () => {
  it('exports settings, projects, detections and activity, and imports them into a fresh database exactly', async () => {
    const source = await app();
    source.settings.set('ui.density', 'compact');
    source.settings.set('backup.keepCount', 4);
    source.projects.add(copyFixture('godot-game'));
    source.projects.add(copyFixture('vite-web'));
    const { file, counts } = source.transfer.export();
    expect(file).toMatchObject({ format: 'gdcc-export', formatVersion: 1, appVersion: 'test' });
    expect(counts.map((c) => c.id)).toEqual(['settings', 'projects', 'project_detections', 'activity_events']);
    expect(counts.find((c) => c.id === 'projects')?.rows).toBe(2);

    const target = await app();
    const parsed = target.transfer.parse(JSON.stringify(file));
    const preview = target.transfer.preview(parsed);
    expect(preview.tables.find((t) => t.id === 'projects')).toMatchObject({ total: 2, added: 2, same: 0, conflicts: 0, blocked: 0 });
    expect(preview.tables.find((t) => t.id === 'project_detections')).toMatchObject({ added: 2, blocked: 0 });
    target.transfer.apply(parsed, 'skip');

    const a = dump(source.db, source.transfer);
    const b = dump(target.db, target.transfer);
    // The target already had its own start-up settings and activity; everything exported must be present and identical.
    expect(b['projects']).toEqual(a['projects']);
    expect(b['project_detections']).toEqual(a['project_detections']);
    for (const row of a['activity_events'] as { id: string }[]) expect(b['activity_events']).toContainEqual(row);
    for (const row of a['settings'] as { key: string }[]) expect(b['settings']).toContainEqual(row);
  });

  it('a second import of the same file changes nothing', async () => {
    const source = await app();
    source.projects.add(copyFixture('godot-game'));
    const text = JSON.stringify(source.transfer.export().file);
    const target = await app();
    target.transfer.apply(target.transfer.parse(text), 'skip');
    const before = dump(target.db, target.transfer);
    const preview = target.transfer.preview(target.transfer.parse(text));
    expect(preview.tables.every((t) => t.added === 0 && t.conflicts === 0 && t.blocked === 0)).toBe(true);
    target.transfer.apply(target.transfer.parse(text), 'replace');
    expect(dump(target.db, target.transfer)).toEqual(before);
  });
});

describe('conflicts are never overwritten silently', () => {
  it('keeps the existing row by default and replaces only when asked', async () => {
    const source = await app();
    const project = source.projects.add(copyFixture('godot-game'));
    source.projects.update({ id: project.id, name: 'From the file' });
    const text = JSON.stringify(source.transfer.export().file);

    const target = await app();
    target.transfer.apply(target.transfer.parse(text), 'skip');
    target.projects.update({ id: project.id, name: 'Renamed here' });

    const parsed = target.transfer.parse(text);
    expect(target.transfer.preview(parsed).tables.find((t) => t.id === 'projects')).toMatchObject({ conflicts: 1, added: 0 });
    const skipped = target.transfer.apply(parsed, 'skip');
    expect(skipped.find((t) => t.id === 'projects')).toMatchObject({ skipped: 1, replaced: 0 });
    expect(target.projects.get(project.id)?.name).toBe('Renamed here');

    const replaced = target.transfer.apply(parsed, 'replace');
    expect(replaced.find((t) => t.id === 'projects')).toMatchObject({ replaced: 1 });
    expect(target.projects.get(project.id)?.name).toBe('From the file');
  });

  it('blocks a project whose folder is already registered under another id, in both modes', async () => {
    const source = await app();
    source.projects.add(copyFixture('godot-game'));
    const file = exported(source.transfer);
    const target = await app();
    const mine = target.projects.add(source.projects.list()[0]?.rootPath as string);
    const parsed = target.transfer.parse(JSON.stringify(file));
    const preview = target.transfer.preview(parsed);
    expect(preview.tables.find((t) => t.id === 'projects')).toMatchObject({ blocked: 1, added: 0 });
    expect(preview.tables.find((t) => t.id === 'project_detections')).toMatchObject({ blocked: 1 });
    for (const mode of ['skip', 'replace'] as ImportConflictMode[]) {
      target.transfer.apply(parsed, mode);
      expect(target.projects.list().map((p) => p.id)).toEqual([mine.id]);
    }
  });
});

describe('hostile or broken imports are rejected with a clear message and change nothing', () => {
  const rejected = async (edit: (file: ExportFile) => unknown, expected: RegExp): Promise<void> => {
    const source = await app();
    source.projects.add(copyFixture('godot-game'));
    const file = exported(source.transfer);
    const replacement = edit(file);
    const text = typeof replacement === 'string' ? replacement : JSON.stringify(file);
    const target = await app();
    const before = dump(target.db, target.transfer);
    const result = codeOf(() => target.transfer.parse(text));
    expect(result.code).toBe('INVALID_INPUT');
    expect(result.message).toMatch(expected);
    expect(dump(target.db, target.transfer)).toEqual(before);
  };
  const projectRow = (file: ExportFile): Record<string, unknown> => (file.tables['projects'] as Record<string, unknown>[])[0] as Record<string, unknown>;

  it('text that is not JSON', () => rejected(() => 'not json {', /not valid JSON/));
  it('JSON that is not an export', () => rejected(() => '{"hello": 1}', /not an export/));
  it('the wrong format name', () => rejected((f) => void ((f as unknown as Record<string, unknown>)['format'] = 'other'), /not an export/));
  it('a newer format version', () => rejected((f) => void (f.formatVersion = 2), /newer version/));
  it('an unknown column in a row', () => rejected((f) => void (projectRow(f)['rootPathOverride'] = 'x'), /Projects, row 1/));
  it('a missing column', () => rejected((f) => delete projectRow(f)['name'], /Projects, row 1/));
  it('a value of the wrong kind', () => rejected((f) => void (projectRow(f)['type'] = 'spaceship'), /Projects, row 1/));
  it('a folder that is not an absolute path', () => rejected((f) => void ((projectRow(f)['root_path'] = '..\\..\\Windows'), (projectRow(f)['root_key'] = '..\\..\\windows')), /absolute/));
  it('a drive root as a project folder', () => rejected((f) => void ((projectRow(f)['root_path'] = 'C:\\'), (projectRow(f)['root_key'] = 'c:')), /whole drive/));
  it('a folder key that does not match the folder', () => rejected((f) => void (projectRow(f)['root_key'] = 'c:\\somewhere\\else'), /does not match/));
  it('the same project twice', () => rejected((f) => void (f.tables['projects'] = [projectRow(f), projectRow(f)] as never), /twice/));
  it('a setting this version does not have', () =>
    rejected((f) => void (f.tables['settings'] = [{ key: 'evil.setting', value_json: '1', updated_at: '2026-10-24T00:00:00.000Z' }]), /not a known setting/));
  it('a setting value that does not fit its key', () =>
    rejected((f) => void (f.tables['settings'] = [{ key: 'ui.density', value_json: '"gigantic"', updated_at: '2026-10-24T00:00:00.000Z' }]), /not valid/));
  it('details that are not JSON', () =>
    rejected(
      (f) =>
        void (f.tables['activity_events'] = [
          { id: 'e1', occurred_at: '2026-10-24T00:00:00.000Z', kind: 'x', severity: 'info', summary: 's', project_id: null, task_id: null, details_json: '{broken' },
        ]),
      /not valid JSON/,
    ));

  it('ignores a table it does not know, with a warning, and imports the rest', async () => {
    const source = await app();
    source.projects.add(copyFixture('godot-game'));
    const file = exported(source.transfer);
    file.tables['future_table'] = [{ a: 1 }];
    const target = await app();
    const parsed = target.transfer.parse(JSON.stringify(file));
    expect(parsed.warnings).toEqual([expect.stringContaining('future_table')]);
    target.transfer.apply(parsed, 'skip');
    expect(target.projects.list()).toHaveLength(1);
  });

  it('rolls everything back when applying fails half way', async () => {
    const source = await app();
    source.projects.add(copyFixture('godot-game'));
    const target = await app();
    const parsed = target.transfer.parse(JSON.stringify(source.transfer.export().file));
    // Break the database underneath the import: the second table fails after the first was written.
    target.db.exec('DROP TABLE project_detections');
    expect(() => target.transfer.apply(parsed, 'skip')).toThrow();
    expect(target.projects.list()).toEqual([]);
  });
});

describe('storage service: export, import and restore through the dialogs in main', () => {
  async function withService(ui: Partial<StorageUi> = {}) {
    const env = await app();
    const confirms: { message: string; detail?: string }[] = [];
    const files = { save: join(makeTempDir(), 'export.json'), open: undefined as string | undefined };
    const fullUi: StorageUi = {
      confirm: (options) => {
        confirms.push({ message: options.message, ...(options.detail === undefined ? {} : { detail: options.detail }) });
        return Promise.resolve(true);
      },
      chooseExportFile: () => Promise.resolve(files.save),
      chooseImportFile: () => Promise.resolve(files.open),
      relaunch: () => undefined,
      ...ui,
    };
    const backups: BackupService = createBackupService({ db: env.db, dir: join(env.dir, 'backups'), logger: env.logger });
    const service = createStorageService({
      db: env.db,
      userDataDir: env.dir,
      backups,
      transfer: env.transfer,
      activity: env.activity,
      logger: env.logger,
      ui: fullUi,
      schemaVersion: () => 3,
      reloadSettings: () => env.settings.reload(),
    });
    return { ...env, service, confirms, files, backups };
  }

  it('exports to the file the user chose, writes nothing when the dialog is cancelled, and records the export', async () => {
    const env = await withService();
    env.projects.add(copyFixture('godot-game'));
    const result = await env.service.exportData();
    expect(result.saved).toBe(true);
    expect(JSON.parse(readFileSync(env.files.save, 'utf8')) as ExportFile).toMatchObject({ format: 'gdcc-export' });
    expect(readdirSync(join(env.files.save, '..'))).toEqual(['export.json']); // no temp file left behind
    expect(env.activity.list({ kinds: ['data.exported'], limit: 5 })).toHaveLength(1);

    const cancelled = await withService({ chooseExportFile: () => Promise.resolve(undefined) });
    expect(await cancelled.service.exportData()).toMatchObject({ saved: false });
    expect(existsSync(cancelled.files.save)).toBe(false);
  });

  it('imports through a preview: new projects need the folder list confirmed, and a backup is made first', async () => {
    const source = await withService();
    const project = source.projects.add(copyFixture('godot-game'));
    await source.service.exportData();

    const target = await withService();
    target.files.open = source.files.save;
    const preview = await target.service.previewImport();
    expect(preview).toMatchObject({ staged: true, fileName: 'export.json', projectFolders: [project.rootPath] });
    expect(target.projects.list()).toEqual([]); // a preview changes nothing

    const result = await target.service.applyImport('skip');
    expect(result.applied).toBe(true);
    expect(target.confirms).toHaveLength(1);
    expect(target.confirms[0]?.detail).toContain(project.rootPath);
    expect(target.projects.list().map((p) => p.id)).toEqual([project.id]);
    expect(target.backups.list().map((b) => b.reason)).toEqual(['pre-import']);
    expect(target.activity.list({ kinds: ['data.imported'], limit: 5 })).toHaveLength(1);
  });

  it('applies nothing when the user declines the confirmation', async () => {
    const source = await withService();
    source.projects.add(copyFixture('godot-game'));
    await source.service.exportData();
    const target = await withService({ confirm: () => Promise.resolve(false) });
    target.files.open = source.files.save;
    await target.service.previewImport();
    expect(await target.service.applyImport('skip')).toEqual({ applied: false, tables: [] });
    expect(target.projects.list()).toEqual([]);
    expect(target.backups.list()).toEqual([]);
  });

  it('replacing existing items is confirmed as an overwrite, and settings are reloaded', async () => {
    const source = await withService();
    source.settings.set('ui.density', 'compact');
    await source.service.exportData();
    const target = await withService();
    target.settings.set('ui.density', 'comfortable'); // a stored value of its own, different from the file's
    target.files.open = source.files.save;
    await target.service.previewImport();
    await target.service.applyImport('skip');
    expect(target.settings.get('ui.density')).toBe('comfortable'); // existing value kept

    await target.service.previewImport();
    expect((await target.service.applyImport('replace')).applied).toBe(true);
    expect(target.confirms.at(-1)?.detail).toContain('overwritten');
    expect(target.settings.get('ui.density')).toBe('compact');
  });

  it('refuses to apply before a file was chosen, and a file that is not an export, with nothing changed', async () => {
    const env = await withService();
    await expect(env.service.applyImport('skip')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const bad = join(makeTempDir(), 'bad.json');
    writeFileSync(bad, '{"format":"gdcc-export"}');
    env.files.open = bad;
    await expect(env.service.previewImport()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(env.service.applyImport('skip')).rejects.toMatchObject({ code: 'INVALID_INPUT' }); // the failed preview staged nothing
    env.files.open = undefined;
    expect(await env.service.previewImport()).toMatchObject({ staged: false });
  });

  it('restore: asks first, backs up the current data, stages the restore and restarts; a refusal does nothing', async () => {
    let relaunched = 0;
    const env = await withService({ relaunch: () => (relaunched += 1) });
    const made = await env.service.backupNow();
    expect(made.reason).toBe('manual');

    const declined = await withService({ confirm: () => Promise.resolve(false), relaunch: () => (relaunched += 1) });
    const other = await declined.service.backupNow();
    expect(await declined.service.restore(other.id)).toEqual({ staged: false });
    expect(declined.backups.list().map((b) => b.reason)).toEqual(['manual']);
    expect(relaunched).toBe(0);

    expect(await env.service.restore(made.id)).toEqual({ staged: true });
    expect(relaunched).toBe(1);
    expect(env.backups.list().map((b) => b.reason).sort()).toEqual(['manual', 'pre-restore']);
    expect(existsSync(join(env.dir, 'data', 'pending-restore.json'))).toBe(true);
    await expect(env.service.restore('..\\data\\gdcc.db')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('status lists the backups, newest first, with the database size and schema version', async () => {
    const env = await withService();
    await env.service.backupNow();
    const status = env.service.status();
    expect(status).toMatchObject({ schemaVersion: 3, lastScheduledAt: null });
    expect(status.databaseBytes).toBeGreaterThan(0);
    expect(status.backups).toHaveLength(1);
    expect(status.backups[0]?.id).toMatch(/^gdcc-.*-manual\.db$/);
  });
});
