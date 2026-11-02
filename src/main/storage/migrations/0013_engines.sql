-- Schema v13 (Step 18): logs of approved command runs, and the optional per-project game profile.
-- `command_runs` keeps the redacted output of every approved command the app ran (a build, a script), so a build log is still there
-- after the run. `project_profiles` holds the Backrooms profile (spec §19): whether it is on, which of its systems the person confirmed
-- against the real design, and the state of its horror-quality checklist. Neither table is exported.

CREATE TABLE command_runs (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  status     TEXT NOT NULL CHECK (status IN ('exited', 'timed-out', 'cancelled', 'output-limit', 'spawn-failed')),
  exit_code  INTEGER,
  output     TEXT NOT NULL DEFAULT '',
  truncated  INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1))
) STRICT;

CREATE INDEX command_runs_project ON command_runs (project_id, started_at);

-- Engine folders the person added by hand. Only main inserts here, from a native folder window: a page cannot name a program location.
CREATE TABLE engine_paths (
  path     TEXT PRIMARY KEY,
  added_at TEXT NOT NULL
) STRICT;

CREATE TABLE project_profiles (
  project_id     TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  profile        TEXT NOT NULL CHECK (profile IN ('backrooms')),
  enabled        INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  domains_json   TEXT NOT NULL DEFAULT '[]',
  checklist_json TEXT NOT NULL DEFAULT '{}',
  updated_at     TEXT NOT NULL
) STRICT;
