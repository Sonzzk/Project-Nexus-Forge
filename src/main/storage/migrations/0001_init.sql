-- Schema v1 (Step 4). Forward-only: never edit this file after it ships; the stored checksum catches edits.
-- Later steps add their tables in new numbered files. See docs/ARCHITECTURE.md section 8.

CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  TEXT NOT NULL,
  app_version TEXT NOT NULL
) STRICT;

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE activity_events (
  id           TEXT PRIMARY KEY,
  occurred_at  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  summary      TEXT NOT NULL,
  project_id   TEXT,
  task_id      TEXT,
  details_json TEXT
) STRICT;
CREATE INDEX activity_events_by_time ON activity_events (occurred_at DESC);
CREATE INDEX activity_events_by_project ON activity_events (project_id, occurred_at DESC);

CREATE TABLE process_runs (
  id         TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  purpose    TEXT NOT NULL,
  executable TEXT NOT NULL,
  args_json  TEXT NOT NULL,
  cwd        TEXT NOT NULL,
  pid        INTEGER,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  status     TEXT NOT NULL CHECK (status IN ('running', 'exited', 'timed-out', 'cancelled', 'output-limit', 'spawn-failed', 'lost')),
  exit_code  INTEGER
) STRICT;
