-- Schema v10 (Step 15): scoped permissions, the approvals log, and the per-project list of approved commands.
-- Grants are made only by a person answering a native window in the main process. These tables are deliberately not exported
-- or imported: a file must never be able to grant a permission.

CREATE TABLE permissions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  task_id     TEXT REFERENCES tasks (id) ON DELETE CASCADE,
  scope       TEXT NOT NULL CHECK (scope IN ('project-writes')),
  what        TEXT NOT NULL,
  working_dir TEXT NOT NULL,
  granted_at  TEXT NOT NULL,
  revoked_at  TEXT
) STRICT;

CREATE INDEX permissions_project ON permissions (project_id, scope) WHERE revoked_at IS NULL;

-- What was approved, where and when: one row per grant, per writing run and per destructive operation.
CREATE TABLE approvals (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  task_id     TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  run_id      TEXT,
  scope       TEXT NOT NULL CHECK (scope IN ('project-writes', 'commands', 'destructive')),
  what        TEXT NOT NULL,
  working_dir TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  at          TEXT NOT NULL
) STRICT;

CREATE INDEX approvals_project ON approvals (project_id, at);

-- A command you approved. `body_hash` is the hash of the script text at that time; a changed script is not run.
CREATE TABLE approved_commands (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  argv_json   TEXT NOT NULL,
  body_hash   TEXT NOT NULL,
  destructive INTEGER NOT NULL CHECK (destructive IN (0, 1)),
  approved_at TEXT NOT NULL,
  revoked_at  TEXT
) STRICT;

CREATE INDEX approved_commands_project ON approved_commands (project_id) WHERE revoked_at IS NULL;
