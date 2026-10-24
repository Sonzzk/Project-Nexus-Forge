# App data: schema, backups, export and import

This document describes the data the app keeps about itself (spec §22). It never describes project content: the app does not copy, move or back up the user's game projects. The schema is the SQL in `src/main/storage/migrations/`; this file explains it. User-facing recovery steps are in [RECOVERY.md](RECOVERY.md).

## Where the data lives

`%APPDATA%\GameDevCommandCenter\` (the display name is not part of the path, D-024):

| Path | What |
|---|---|
| `data\gdcc.db` | The SQLite database (WAL mode while the app runs). |
| `data\gdcc.replaced-<time>.db`, `data\gdcc.corrupt-<time>.db` | A database that was swapped out by a restore or set aside by recovery. Renamed, never deleted. |
| `data\pending-restore.json` | Present only between choosing a restore and the next start. |
| `backups\gdcc-<UTC time>-<reason>.db` | Backups. Reasons: `manual`, `scheduled`, `pre-migration`, `pre-restore`, `pre-import`. Each is one self-contained, integrity-checked file. |
| `logs\main.log` | Rotated, redacted log. |

## Schema (version 8)

All tables are `STRICT`. Times are ISO-8601 UTC text. Migrations are forward-only, numbered, checksummed and never edited after they ship.

| Table | Since | Holds | Notes |
|---|---|---|---|
| `schema_migrations` | 1 | version, name, checksum, applied time, app version | One row per applied migration. |
| `settings` | 1 | `key`, `value_json`, `updated_at` | One row per key; every value is validated against `SettingsSchema`. |
| `activity_events` | 1 | id, time, kind, severity, summary, project id, task id, details (JSON, redacted) | The user-facing history. `project_id` has no foreign key on purpose, so history outlives a project. |
| `process_runs` | 1 | owner, purpose, executable, arguments (redacted), folder, pid, start and end, status, exit code | Every program the app starts. |
| `projects` | 2 | name, description, type and its source, engine and version, `root_path`, `root_key` (unique), status, tags, instructions, AI and backup preferences (JSON), times | A registered folder. Removing a row never touches the folder. |
| `project_detections` | 2 | project (cascade), time, type, confidence, engine, evidence (JSON) | What the project's files said when last read. |
| `audits` | 3 | id, project (cascade), start and finish, file count, the whole report (JSON) | Newest ten per project. |
| `memory_settings` | 4 | project (cascade), storage (`app`, `project` or `docs-dir`), docs folder | No row means the app database. |
| `project_docs` | 4 | project (cascade), document type, content, time | Memory documents stored in the app. |
| `context_packs` | 4 | project (cascade), title, task, budget, destination, hand-picked files, manifest (JSON), estimate | The manifest holds size, time and hash per item, not contents. |
| `handoffs` | 4 | project (cascade), time, the seven handoff fields | |
| `milestones` | 5 | project (cascade), title, status, scope tier, order, target date | Progress is computed, never stored. |
| `tasks` | 5 | every field of spec §10, status, the status it was blocked from, plan approval time, milestone and parent (cleared when they are deleted) | Subtasks are one level deep. |
| `task_dependencies` | 5 | task, depends on (both cascade) | Loops are refused when set and when imported. |
| `task_notes` | 5 | task (cascade), time, text | |
| `risks` | 5 | project (cascade), kind (bug or risk), title, severity, status, optional task | The bugs and risks register. |
| `milestone_snapshots` | 5 | milestone (cascade), time, label, progress and counts by status | |
| `agent_runs` | 6 | project (cascade), task, workflow, step, role, provider text, state, write-capable, optional, note; from 8 also priority, model, attempt, the run it retries, the routing decision (JSON), the answer, and when a start was asked for | A record of one role working on one task. Only the run queue starts it, and only read-only roles until Step 15. `requested_at` is not exported: an imported run never waits to start. |
| `agent_run_transitions` | 6 | run (cascade), from and to state, time, reason | The state history. |
| `provider_checks` | 7 | provider, time, status, version, message, hint, details, last successful request | What the last check found; derived, so it is not exported. No credentials. |
| `writer_locks` | 8 | project (primary key, cascade), run, time taken, working folder | One writer per project. Kept across restarts until the person releases a lock left by an interrupted run; not exported, because a lock only means something on the PC where that run ran. |

Later steps add their tables in new migrations (ARCHITECTURE.md section 8, "Tables later steps add") and register them for export (below).

## Backups

- **What:** the app database only, made with SQLite's online backup, then sealed into one file (no WAL side files) and checked with `PRAGMA quick_check`. A backup that fails the check is deleted and reported.
- **When:** automatically before every migration (a brand-new database has nothing to lose); on demand ("Back up now"); optionally on a schedule (`backup.scheduleEnabled`, `backup.intervalHours`, checked every ten minutes while the app runs); before a restore; before an import.
- **Retention:** the newest `backup.keepCount` (default 10, range 1 to 100) of each reason. Older ones of that reason are removed; other reasons are not touched.
- **Content:** settings, the project list (paths and notes, not files), audits, activity, process history. No project content, no credentials.

## Restore

The database is open while the app runs, so a restore is staged and applied at the next start:

1. The user picks a backup (by file name) and confirms in a dialog opened by the main process.
2. The backup is verified (integrity check, schema version not newer than the app).
3. The current data is backed up (`pre-restore`).
4. `data\pending-restore.json` names the backup and the app restarts.
5. Before anything opens the database, the start-up code verifies the backup again, renames `gdcc.db` (and any `-wal` and `-shm` files) to `gdcc.replaced-<time>.db`, and copies the backup into place. If anything fails, the original is put back, the marker is removed and the failure is recorded; a failed restore is never retried.

## Damaged or newer databases

At start-up the database gets an integrity check. If it fails (`DB_CORRUPT`) or was made by a newer app (`DB_NEWER_THAN_APP`), the app shows a native dialog and does not write anything. The choices are: restore the newest usable backup (one that passes its check and is not newer than this app), open the backups folder, start a new empty database (the old file is renamed `gdcc.corrupt-<time>.db`), or quit. There is no read-only mode for a newer database (D-033).

## Export and import

Format `gdcc-export`, `formatVersion` 1: `{ format, formatVersion, appVersion, schemaVersion, exportedAt, tables: { <table id>: [ row, ... ] } }`. Rows are plain objects with one field per column.

Exported tables today: `settings`, `projects`, `project_detections`, `memory_settings`, `project_docs`, `context_packs`, `handoffs`, `milestones`, `tasks`, `task_dependencies`, `task_notes`, `risks`, `milestone_snapshots`, `agent_runs`, `agent_run_transitions`, `activity_events`. Audits are left out because they can be run again.

Import rules:

- The file is read in main from a file the user chose in a native dialog (at most 100 MB), parsed, and every row is validated with the table's strict Zod schema plus its own checks (known setting keys and valid values; absolute project folders that are not a whole drive and match their key; JSON columns that parse). Unknown columns, missing columns, wrong values, duplicate keys and a newer format version are rejected, with the first problems named. A table this version does not know is ignored with a warning.
- A preview classifies every row: new, same, different (same key, other content), or blocked (it clashes with another row's unique value, or its parent row is missing). Nothing is written by a preview.
- Applying keeps existing data by default. "Replace" overwrites rows with the same key and needs a native confirmation that says how many. Blocked rows are never imported.
- New projects register folders, which normally only the folder picker can do, so a native confirmation lists the folders first.
- The current data is backed up (`pre-import`) and all writes run in one transaction; an error rolls everything back.

## Making a table exportable

A step that adds a table registers it once at start-up (`src/main/index.ts`):

```ts
transfer.register({
  id: 'tasks',                       // SQL table name and name in the file
  label: 'Tasks',
  schema: z.strictObject({ ... }),   // one field per column; text, integer or null
  key: ['id'],                       // primary key columns
  unique: [['slug']],                // optional: other unique column sets
  parents: [{ column: 'project_id', table: 'projects', parentColumn: 'id' }],
  check: (row) => (isBad(row) ? 'why' : undefined),   // optional extra rule
  needsConfirmation: (row) => undefined,              // optional: text the user must confirm
});
```

Tables are exported and imported in registration order, so register a parent before its children. The definition lives in the feature's own module (see `src/main/projects/export.ts`) and is exported from that module's index.
