-- Schema v7 (Step 12): what the last check of each AI provider found. Only facts the app observed are stored; there is no
-- configuration with secrets here (credentials stay with each tool and are never read).

CREATE TABLE provider_checks (
  provider_id     TEXT PRIMARY KEY,
  checked_at      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('not-installed', 'installed', 'needs-setup', 'working', 'error')),
  version         TEXT,
  message         TEXT NOT NULL,
  hint            TEXT NOT NULL DEFAULT '',
  details_json    TEXT NOT NULL,
  last_success_at TEXT
) STRICT;
