-- Schema v3 (Step 7): stored project audits. An audit is derived data about a registered project, so it goes with the project.
-- The whole report is kept as JSON; the columns are what the list view needs.

CREATE TABLE audits (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  started_at  TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  files       INTEGER NOT NULL,
  report_json TEXT NOT NULL
) STRICT;
CREATE INDEX audits_by_project ON audits (project_id, finished_at DESC);
