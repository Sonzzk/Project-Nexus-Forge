-- Schema v16 (Step 22): the asset inventory.
-- `asset_index` is a metadata-only list of a project's game content (path, category, size, modification time), rebuilt by scanning; it
-- holds no file content and is not exported. `asset_scans` remembers the last scan of each project. `asset_details` and
-- `asset_task_refs` hang off a tracked asset (the person's own annotation, Step 19): where the file came from and how it is used, and
-- the tasks that need it. Both are the person's notes and are exported with `tracked_assets`.

CREATE TABLE asset_index (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  rel_path   TEXT NOT NULL,
  category   TEXT NOT NULL CHECK (category IN ('model', 'texture', 'material', 'audio', 'animation', 'scene', 'script', 'font', 'video', 'build', 'engine')),
  ext        TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mtime_ms   INTEGER NOT NULL CHECK (mtime_ms >= 0),
  scanned_at TEXT NOT NULL,
  PRIMARY KEY (project_id, rel_path)
) STRICT;

CREATE INDEX asset_index_category ON asset_index (project_id, category);

CREATE TABLE asset_scans (
  project_id  TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  scanned_at  TEXT NOT NULL,
  entries     INTEGER NOT NULL,
  files       INTEGER NOT NULL,
  added       INTEGER NOT NULL,
  changed     INTEGER NOT NULL,
  removed     INTEGER NOT NULL,
  unchanged   INTEGER NOT NULL,
  truncated   INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  duration_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE asset_details (
  asset_id TEXT PRIMARY KEY REFERENCES tracked_assets (id) ON DELETE CASCADE,
  source   TEXT NOT NULL DEFAULT '',
  usage    TEXT NOT NULL DEFAULT ''
) STRICT;

CREATE TABLE asset_task_refs (
  asset_id TEXT NOT NULL REFERENCES tracked_assets (id) ON DELETE CASCADE,
  task_id  TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  PRIMARY KEY (asset_id, task_id)
) STRICT;

CREATE INDEX asset_task_refs_task ON asset_task_refs (task_id);
