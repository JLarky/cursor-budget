export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY,
  timestamp TEXT NOT NULL,
  conversation_id TEXT,
  generation_id TEXT,
  event_type TEXT NOT NULL,
  model TEXT,
  model_id TEXT,
  observable_input_tokens INTEGER DEFAULT 0,
  observable_output_tokens INTEGER DEFAULT 0,
  observable_reasoning_tokens INTEGER DEFAULT 0,
  estimated_tokens INTEGER DEFAULT 0,
  observable_cost_usd REAL DEFAULT 0,
  estimated_cost_usd REAL DEFAULT 0,
  metadata TEXT,
  dedupe_key TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_events(timestamp);

CREATE TABLE IF NOT EXISTS context_snapshots (
  id INTEGER PRIMARY KEY,
  timestamp TEXT NOT NULL,
  conversation_id TEXT,
  generation_id TEXT,
  context_tokens INTEGER,
  context_window_size INTEGER,
  context_usage_percent REAL,
  trigger TEXT,
  metadata TEXT,
  dedupe_key TEXT UNIQUE
);

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
