-- Schema v4 (Step 9): project memory, context packs and session handoffs. All of it is about a registered project and goes
-- with the project when it is removed from the registry; the project's own files are never part of it.

-- Where a project's memory documents live. No row means the default: the app database.
CREATE TABLE memory_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  storage    TEXT NOT NULL CHECK (storage IN ('app', 'project', 'docs-dir')),
  docs_dir   TEXT NOT NULL DEFAULT ''
) STRICT;

-- Memory documents stored in the app database (storage = 'app').
CREATE TABLE project_docs (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  doc_type   TEXT NOT NULL,
  content    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, doc_type)
) STRICT;

-- Saved context packs: the request and a manifest of what was included (size, time and hash per file), not the file contents.
CREATE TABLE context_packs (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  task           TEXT NOT NULL,
  token_budget   INTEGER NOT NULL,
  destination    TEXT NOT NULL,
  extra_files_json TEXT NOT NULL,
  manifest_json  TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;
CREATE INDEX context_packs_by_project ON context_packs (project_id, created_at DESC);

-- Session handoffs: the seven fields of spec section 8.
CREATE TABLE handoffs (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  requested  TEXT NOT NULL,
  changed    TEXT NOT NULL,
  verified   TEXT NOT NULL,
  unfinished TEXT NOT NULL,
  risks      TEXT NOT NULL,
  files      TEXT NOT NULL,
  next_task  TEXT NOT NULL
) STRICT;
CREATE INDEX handoffs_by_project ON handoffs (project_id, created_at DESC);
