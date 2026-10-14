CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT    NOT NULL,
  type     TEXT    NOT NULL,          -- 'open' | 'click'
  url      TEXT,                      -- click target
  ts       INTEGER NOT NULL,          -- ms since epoch
  ua       TEXT,
  country  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_email ON events (email_id, ts);

CREATE TABLE IF NOT EXISTS self_views (
  email_id TEXT    NOT NULL,
  ts       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_self_views_email ON self_views (email_id, ts);
