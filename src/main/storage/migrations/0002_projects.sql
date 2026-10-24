-- Schema v2 (Step 6): the project registry. A project is a folder the user registered; the folder itself is never changed.

CREATE TABLE projects (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  type             TEXT NOT NULL CHECK (type IN ('unreal', 'unity', 'godot', 'web-vite', 'web', 'general-code', 'custom')),
  type_source      TEXT NOT NULL CHECK (type_source IN ('detected', 'manual')),
  engine           TEXT,
  engine_version   TEXT,
  root_path        TEXT NOT NULL,
  root_key         TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL CHECK (status IN ('active', 'paused', 'archived')),
  tags_json        TEXT NOT NULL DEFAULT '[]',
  instructions     TEXT NOT NULL DEFAULT '',
  ai_prefs_json    TEXT NOT NULL DEFAULT '{}',
  backup_prefs_json TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;

CREATE TABLE project_detections (
  project_id     TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  detected_at    TEXT NOT NULL,
  type           TEXT NOT NULL,
  confidence     TEXT NOT NULL CHECK (confidence IN ('confirmed', 'inferred')),
  engine         TEXT,
  engine_version TEXT,
  evidence_json  TEXT NOT NULL
) STRICT;
