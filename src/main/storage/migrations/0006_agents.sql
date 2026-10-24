-- Schema v6 (Step 11): agent run records and their state history. A run is a record of one role working on one task. In this
-- step nothing starts a program; the records and their states exist so that Steps 12 and 13 can drive them.

CREATE TABLE agent_runs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  task_id       TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  workflow_id   TEXT,
  step_index    INTEGER NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('planner', 'implementer', 'reviewer', 'qa', 'docs', 'assets')),
  provider_id   TEXT NOT NULL DEFAULT '',
  state         TEXT NOT NULL CHECK (state IN ('queued', 'planning', 'awaiting-approval', 'running', 'awaiting-review', 'testing', 'completed', 'failed', 'cancelled')),
  write_capable INTEGER NOT NULL CHECK (write_capable IN (0, 1)),
  optional      INTEGER NOT NULL CHECK (optional IN (0, 1)),
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;
CREATE INDEX agent_runs_by_task ON agent_runs (task_id, created_at);
CREATE INDEX agent_runs_by_project ON agent_runs (project_id, state);

CREATE TABLE agent_run_transitions (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
  from_state TEXT NOT NULL,
  to_state   TEXT NOT NULL,
  at         TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE INDEX agent_run_transitions_by_run ON agent_run_transitions (run_id, at);
