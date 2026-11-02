-- Schema v11 (Step 16): change sessions and working trees.
-- A change session is opened when a writing run is approved. `state_commit` holds the project as it was (tracked changes included),
-- `untracked_json` and `dirty_json` list what was already untracked or modified, so only the agent's own changes are counted.
-- Like permissions, these tables are not exported: they point at commits and folders on this PC.

CREATE TABLE change_sessions (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  task_id             TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  run_id              TEXT NOT NULL,
  role_label          TEXT NOT NULL,
  base_commit         TEXT NOT NULL,
  state_commit        TEXT NOT NULL,
  checkpoint_ref      TEXT NOT NULL,
  untracked_json      TEXT NOT NULL,
  dirty_json          TEXT NOT NULL,
  untracked_truncated INTEGER NOT NULL CHECK (untracked_truncated IN (0, 1)),
  started_at          TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('open', 'approved', 'rejected')),
  commit_hash         TEXT,
  finished_at         TEXT
) STRICT;

CREATE INDEX change_sessions_project ON change_sessions (project_id, started_at);

-- Linked Git working trees the app created, so it can list and remove only its own.
CREATE TABLE worktrees (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL,
  branch     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  removed_at TEXT
) STRICT;

CREATE INDEX worktrees_project ON worktrees (project_id) WHERE removed_at IS NULL;
