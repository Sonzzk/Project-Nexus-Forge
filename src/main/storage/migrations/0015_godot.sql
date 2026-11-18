-- Schema v15 (Step 20): Godot integration.
-- `tool_paths` (install folders the person added by hand; only main inserts, from a native folder window) now also accepts 'godot'.
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt with its rows. No other table changes.

CREATE TABLE tool_paths_v15 (
  tool     TEXT NOT NULL CHECK (tool IN ('blender', 'godot')),
  path     TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (tool, path)
) STRICT;

INSERT INTO tool_paths_v15 (tool, path, added_at) SELECT tool, path, added_at FROM tool_paths;
DROP TABLE tool_paths;
ALTER TABLE tool_paths_v15 RENAME TO tool_paths;
