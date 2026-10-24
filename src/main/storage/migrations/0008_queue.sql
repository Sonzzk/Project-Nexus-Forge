-- Schema v8 (Step 13): the run queue and the per-project writer lock. A run gains its queue priority, the model and routing
-- decision it was started with, its attempt number, the answer it returned, and when the person asked for it to start.
-- The writer lock is one row per project; it is kept across restarts so an interrupted writer is never forgotten.

ALTER TABLE agent_runs ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical'));
ALTER TABLE agent_runs ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1);
ALTER TABLE agent_runs ADD COLUMN retry_of TEXT REFERENCES agent_runs (id) ON DELETE SET NULL;
ALTER TABLE agent_runs ADD COLUMN route_json TEXT;
ALTER TABLE agent_runs ADD COLUMN result TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_runs ADD COLUMN requested_at TEXT;
CREATE INDEX agent_runs_waiting ON agent_runs (requested_at) WHERE requested_at IS NOT NULL;

CREATE TABLE writer_locks (
  project_id  TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  run_id      TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  working_dir TEXT NOT NULL
) STRICT;
