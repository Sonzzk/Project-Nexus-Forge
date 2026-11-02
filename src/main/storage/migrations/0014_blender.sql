-- Schema v14 (Step 19): Blender integration and asset management.
-- `tool_paths` are install folders the person added by hand (only main inserts, from a native folder window). `approved_scripts` are the
-- Python scripts the person approved, bound to the script's hash. `blender_runs` record every headless Blender run (on a copy), what it
-- wrote and whether the original file was left alone. `tracked_assets` and `asset_briefs` are the person's own notes about asset files and
-- what an asset must be; they point at project-relative paths and are exported. The other three tables are machine-bound and are not.

CREATE TABLE tool_paths (
  tool     TEXT NOT NULL CHECK (tool IN ('blender')),
  path     TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (tool, path)
) STRICT;

CREATE TABLE approved_scripts (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  rel_path    TEXT NOT NULL,
  hash        TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  revoked_at  TEXT
) STRICT;

CREATE INDEX approved_scripts_project ON approved_scripts (project_id, rel_path);

CREATE TABLE blender_runs (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('inspect', 'script')),
  source_rel         TEXT NOT NULL,
  script_rel         TEXT,
  script_hash        TEXT,
  blender_folder     TEXT NOT NULL,
  blender_version    TEXT,
  started_at         TEXT NOT NULL,
  ended_at           TEXT,
  status             TEXT NOT NULL,
  exit_code          INTEGER,
  outcome            TEXT NOT NULL CHECK (outcome IN ('passed', 'failed', 'inconclusive')),
  original_unchanged INTEGER NOT NULL CHECK (original_unchanged IN (0, 1)),
  work_dir           TEXT NOT NULL,
  outputs_json       TEXT NOT NULL DEFAULT '[]',
  result_json        TEXT,
  log                TEXT NOT NULL DEFAULT '',
  truncated          INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  error_summary      TEXT NOT NULL DEFAULT ''
) STRICT;

CREATE INDEX blender_runs_project ON blender_runs (project_id, started_at);

CREATE TABLE tracked_assets (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  rel_path   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  tags_json  TEXT NOT NULL DEFAULT '[]',
  size_bytes INTEGER NOT NULL,
  mtime_ms   INTEGER NOT NULL,
  tracked_at TEXT NOT NULL,
  UNIQUE (project_id, rel_path)
) STRICT;

CREATE TABLE asset_briefs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  asset_type  TEXT NOT NULL,
  engine      TEXT NOT NULL,
  purpose     TEXT NOT NULL DEFAULT '',
  scale       TEXT NOT NULL DEFAULT '',
  formats     TEXT NOT NULL DEFAULT '',
  textures    TEXT NOT NULL DEFAULT '',
  performance TEXT NOT NULL DEFAULT '',
  integration TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  task_id     TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  asset_id    TEXT REFERENCES tracked_assets (id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;

CREATE INDEX asset_briefs_project ON asset_briefs (project_id, updated_at);
