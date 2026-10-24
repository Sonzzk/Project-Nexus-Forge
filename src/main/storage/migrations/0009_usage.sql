-- Schema v9 (Step 14): the local usage log. One row per request really sent to a provider, and one per launch a limit stopped.
-- Token counts and the cost estimate are NULL unless the provider returned them; they are never filled with a guess or a zero.
-- Rows outlive the project and task they name (the links are cleared, the row stays) so the history stays honest.

CREATE TABLE usage_log (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES projects (id) ON DELETE SET NULL,
  task_id       TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  run_id        TEXT,
  purpose       TEXT NOT NULL CHECK (purpose IN ('connection-test', 'task-breakdown', 'document-draft', 'project-session', 'agent-run')),
  provider_id   TEXT NOT NULL CHECK (provider_id IN ('ollama', 'claude-code', 'codex')),
  model         TEXT NOT NULL DEFAULT '',
  location      TEXT NOT NULL CHECK (location IN ('local', 'cloud')),
  status        TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'blocked', 'interrupted')),
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  input_tokens  INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_usd      REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  reason        TEXT NOT NULL DEFAULT ''
) STRICT;

CREATE INDEX usage_log_started ON usage_log (started_at);
CREATE INDEX usage_log_project ON usage_log (project_id, started_at);
CREATE INDEX usage_log_task ON usage_log (task_id);
