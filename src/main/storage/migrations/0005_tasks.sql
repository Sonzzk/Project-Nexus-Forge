-- Schema v5 (Step 10): task planning. Milestones, tasks, dependencies, notes, the bugs and risks register and milestone
-- snapshots. Everything belongs to a registered project and goes with it when it is removed from the registry.

CREATE TABLE milestones (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL CHECK (status IN ('planned', 'active', 'done', 'cancelled')),
  scope_tier  TEXT NOT NULL CHECK (scope_tier IN ('dream', 'prototype', 'slice', 'release')),
  order_index INTEGER NOT NULL,
  target_date TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;
CREATE INDEX milestones_by_project ON milestones (project_id, order_index);

CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  milestone_id      TEXT REFERENCES milestones (id) ON DELETE SET NULL,
  parent_id         TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  subsystem         TEXT NOT NULL DEFAULT '',
  priority          TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  complexity        TEXT NOT NULL CHECK (complexity IN ('', 'xs', 's', 'm', 'l', 'xl')),
  category          TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL CHECK (status IN ('inbox', 'planned', 'ready', 'in-progress', 'review', 'testing', 'done', 'blocked', 'cancelled', 'failed')),
  blocked_from      TEXT,
  acceptance_json   TEXT NOT NULL DEFAULT '[]',
  files_json        TEXT NOT NULL DEFAULT '[]',
  role              TEXT NOT NULL DEFAULT '',
  provider          TEXT NOT NULL DEFAULT '',
  usage             TEXT NOT NULL DEFAULT '',
  test_requirements TEXT NOT NULL DEFAULT '',
  result_notes      TEXT NOT NULL DEFAULT '',
  plan_approved_at  TEXT,
  order_index       INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  done_at           TEXT
) STRICT;
CREATE INDEX tasks_by_project ON tasks (project_id, status);
CREATE INDEX tasks_by_milestone ON tasks (milestone_id);

CREATE TABLE task_dependencies (
  task_id       TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
) STRICT;

CREATE TABLE task_notes (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  text       TEXT NOT NULL
) STRICT;
CREATE INDEX task_notes_by_task ON task_notes (task_id, created_at);

CREATE TABLE risks (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('bug', 'risk')),
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  severity    TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  status      TEXT NOT NULL CHECK (status IN ('open', 'mitigated', 'closed')),
  task_id     TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;
CREATE INDEX risks_by_project ON risks (project_id, status);

CREATE TABLE milestone_snapshots (
  id           TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones (id) ON DELETE CASCADE,
  taken_at     TEXT NOT NULL,
  label        TEXT NOT NULL,
  progress_json TEXT NOT NULL,
  by_status_json TEXT NOT NULL
) STRICT;
CREATE INDEX milestone_snapshots_by_milestone ON milestone_snapshots (milestone_id, taken_at);
