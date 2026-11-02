-- Schema v12 (Step 17): session records for agent runs (spec §15). One row per run that was really started: what was observed about it,
-- and nothing that was not. `provider_session_id` is whatever the provider printed; denials are the permission requests the provider
-- itself reported as denied; `output` is the run's answer with secrets removed, kept after the run so the history stays readable.
-- Not exported: the rows describe programs that ran on this PC.

CREATE TABLE run_sessions (
  run_id              TEXT PRIMARY KEY REFERENCES agent_runs (id) ON DELETE CASCADE,
  project_id          TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  provider_id         TEXT NOT NULL,
  model               TEXT NOT NULL,
  working_dir         TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  outcome             TEXT NOT NULL CHECK (outcome IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
  exit_code           INTEGER,
  provider_session_id TEXT,
  denials_json        TEXT NOT NULL DEFAULT '[]',
  tools_json          TEXT NOT NULL DEFAULT '[]',
  error               TEXT NOT NULL DEFAULT '',
  output              TEXT NOT NULL DEFAULT '',
  output_truncated    INTEGER NOT NULL DEFAULT 0 CHECK (output_truncated IN (0, 1)),
  streamed            INTEGER NOT NULL DEFAULT 0 CHECK (streamed IN (0, 1))
) STRICT;

CREATE INDEX run_sessions_project ON run_sessions (project_id, started_at);
