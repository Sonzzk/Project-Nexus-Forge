import { useState } from 'react';
import type { BackupReasonName, ExportResult, ImportConflictMode, ImportPreview, ImportResult } from '@shared/storage';
import { formatTime } from '../../lib/activity';
import { useSettings } from '../../lib/settings';
import { useStorage } from '../../lib/storage';

const REASON_LABELS: Record<BackupReasonName, string> = {
  manual: 'Manual',
  scheduled: 'Scheduled',
  'pre-migration': 'Before an update',
  'pre-restore': 'Before a restore',
  'pre-import': 'Before an import',
};
const INTERVALS = [6, 12, 24, 72, 168] as const;

const sizeText = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);

/** Backups, restore, export and import of the app's own data (spec §22). Project folders are never copied. */
export function DataSection() {
  const { settings, set } = useSettings();
  const { status, error, busy, backupNow, restore, exportData, previewImport, applyImport } = useStorage();
  const [exported, setExported] = useState<ExportResult | undefined>();
  const [preview, setPreview] = useState<ImportPreview | undefined>();
  const [mode, setMode] = useState<ImportConflictMode>('skip');
  const [imported, setImported] = useState<ImportResult | undefined>();
  const [restarting, setRestarting] = useState(false);

  const interval = settings['backup.intervalHours'];
  const intervals = INTERVALS.some((hours) => hours === interval) ? INTERVALS : [...INTERVALS, interval].sort((a, b) => a - b);
  const conflicts = preview?.tables.reduce((n, t) => n + t.conflicts, 0) ?? 0;

  return (
    <section className="card" aria-label="Data and backups">
      <div className="card__head">
        <h2>Data and backups</h2>
      </div>
      <p className="muted">
        Backups and exports hold the app&apos;s own data (settings, project list, audits, activity). They never contain your project
        folders or files.
      </p>
      {error !== undefined && (
        <p role="alert">
          {error.message} {error.hint}
        </p>
      )}

      <h3>Backups</h3>
      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={settings['backup.scheduleEnabled']}
            onChange={(event) => set('backup.scheduleEnabled', event.target.checked)}
          />{' '}
          Back up automatically
        </label>
        <label htmlFor="backup-interval" className="muted">
          every
        </label>
        <select
          id="backup-interval"
          value={interval}
          disabled={!settings['backup.scheduleEnabled']}
          onChange={(event) => set('backup.intervalHours', Number(event.target.value))}
        >
          {intervals.map((hours) => (
            <option key={hours} value={hours}>
              {hours < 24 ? `${hours} hours` : `${hours / 24} day${hours === 24 ? '' : 's'}`}
            </option>
          ))}
        </select>
        <label htmlFor="backup-keep" className="muted">
          keep the newest
        </label>
        <input
          id="backup-keep"
          type="number"
          min={1}
          max={100}
          value={settings['backup.keepCount']}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isInteger(value) && value >= 1 && value <= 100) set('backup.keepCount', value);
          }}
        />
        <span className="muted">of each kind</span>
      </div>
      <div className="actions">
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void backupNow()}>
          Back up now
        </button>
        {status !== undefined && (
          <span className="muted" role="status">
            Database {sizeText(status.databaseBytes)} · schema {status.schemaVersion}
          </span>
        )}
      </div>
      {status !== undefined && status.backups.length === 0 && <p className="empty">No backups yet.</p>}
      {status !== undefined && status.backups.length > 0 && (
        <ul className="rows" aria-label="Backups">
          {status.backups.map((backup) => (
            <li key={backup.id} className="backup-row">
              <span>{formatTime(backup.createdAt)}</span>
              <span className="badge">{REASON_LABELS[backup.reason]}</span>
              <span className="muted">{sizeText(backup.sizeBytes)}</span>
              <button
                type="button"
                className="btn"
                disabled={busy || restarting}
                aria-label={`Restore the backup from ${formatTime(backup.createdAt)}`}
                onClick={() => void restore(backup.id).then((staged) => setRestarting(staged))}
              >
                Restore…
              </button>
            </li>
          ))}
        </ul>
      )}
      {restarting && <p role="status">Restoring: the app is restarting with the restored data.</p>}

      <h3>Export</h3>
      <p className="muted">
        Saves settings, projects, project detections and the activity history to a JSON file you choose. It contains your project
        folder names and notes, so keep it private.
      </p>
      <div className="actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void exportData().then(setExported)}>
          Export data…
        </button>
        {exported?.saved === true && (
          <span role="status">Saved {exported.tables.reduce((n, t) => n + t.rows, 0).toLocaleString('en-US')} rows.</span>
        )}
        {exported?.saved === false && <span className="muted">Export cancelled.</span>}
      </div>

      <h3>Import</h3>
      <p className="muted">
        Choose an export made by this app. You see what it would add first; nothing changes until you press Import. Your current
        data is backed up before anything is written.
      </p>
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void previewImport().then((result) => {
              setPreview(result?.staged === true ? result : undefined);
              setImported(undefined);
              setMode('skip');
            })
          }
        >
          Choose a file to import…
        </button>
      </div>
      {preview !== undefined && (
        <div aria-label="Import preview" role="region">
          <p>
            <strong>{preview.fileName}</strong>
            <span className="muted">
              {' '}
              · exported {preview.exportedAt === undefined ? '' : formatTime(preview.exportedAt)} by version {preview.appVersion}
            </span>
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Data</th>
                <th>In file</th>
                <th>New</th>
                <th>Same</th>
                <th>Different</th>
                <th>Blocked</th>
              </tr>
            </thead>
            <tbody>
              {preview.tables.map((table) => (
                <tr key={table.id}>
                  <td>{table.label}</td>
                  <td>{table.total}</td>
                  <td>{table.added}</td>
                  <td>{table.same}</td>
                  <td>{table.conflicts}</td>
                  <td>{table.blocked}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.warnings.map((warning) => (
            <p key={warning} className="muted">
              {warning}
            </p>
          ))}
          {preview.projectFolders.length > 0 && (
            <>
              <p>New projects would register these folders (the app only reads them; you confirm the list before the import):</p>
              <ul className="evidence">
                {preview.projectFolders.slice(0, 20).map((folder) => (
                  <li key={folder} className="mono">
                    {folder}
                  </li>
                ))}
              </ul>
            </>
          )}
          {conflicts > 0 && (
            <fieldset className="choice">
              <legend>{conflicts} item(s) exist here with different content</legend>
              <label>
                <input type="radio" name="conflict" checked={mode === 'skip'} onChange={() => setMode('skip')} /> Keep what I have
                (recommended)
              </label>
              <label>
                <input type="radio" name="conflict" checked={mode === 'replace'} onChange={() => setMode('replace')} /> Replace with the
                file&apos;s version
              </label>
            </fieldset>
          )}
          <div className="actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={() =>
                void applyImport(mode).then((result) => {
                  setImported(result);
                  if (result?.applied === true) setPreview(undefined);
                })
              }
            >
              Import
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setPreview(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {imported?.applied === false && <p role="status">Nothing was imported.</p>}
      {imported?.applied === true && (
        <div role="status">
          <p>
            Imported:{' '}
            {imported.tables
              .filter((t) => t.added + t.replaced + t.skipped > 0)
              .map((t) => `${t.label} ${t.added} added, ${t.replaced} replaced, ${t.skipped} skipped`)
              .join(' · ') || 'nothing new'}
            .
          </p>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload the app data
          </button>
        </div>
      )}
    </section>
  );
}
