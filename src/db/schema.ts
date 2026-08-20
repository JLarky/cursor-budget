export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY,
  timestamp TEXT NOT NULL,
  conversation_id TEXT,
  generation_id TEXT,
  event_type TEXT NOT NULL,
  model TEXT,
  dedupe_key TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_events(timestamp);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS warning_emissions (
  window_id TEXT NOT NULL,
  threshold REAL NOT NULL,
  period_key TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  PRIMARY KEY (window_id, threshold, period_key)
);
`;
