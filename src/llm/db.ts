import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { llmDbPath } from "./paths.js";

export type { DatabaseSync };

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS token_events (
  event_key TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  session_id TEXT,
  model TEXT,
  project TEXT,
  ts TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_token_events_agent_ts ON token_events(agent, ts);

CREATE TABLE IF NOT EXISTS scan_checkpoints (
  path_hash TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  parser_version TEXT NOT NULL,
  scanned_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface TokenEventRow {
  event_key: string;
  agent: string;
  session_id?: string;
  model?: string;
  project?: string;
  ts: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

let cached: DatabaseSync | null = null;

export function openLlmDb(home?: string): DatabaseSync {
  if (cached && !home) return cached;
  const path = llmDbPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  if (!home) cached = db;
  return db;
}

/**
 * Insert a parsed usage event, keeping the fullest counters when the same
 * event key reappears (transcripts can repeat a message with growing totals
 * while it streams).
 */
export function upsertTokenEvent(db: DatabaseSync, row: TokenEventRow): "inserted" | "updated" | "kept" {
  const existing = db
    .prepare("SELECT total_tokens FROM token_events WHERE event_key = ?")
    .get(row.event_key) as { total_tokens: number } | undefined;
  if (!existing) {
    db.prepare(
      `INSERT INTO token_events (
        event_key, agent, session_id, model, project, ts,
        input_tokens, output_tokens, reasoning_tokens,
        cache_read_tokens, cache_write_tokens, total_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.event_key,
      row.agent,
      row.session_id ?? null,
      row.model ?? null,
      row.project ?? null,
      row.ts,
      row.input_tokens,
      row.output_tokens,
      row.reasoning_tokens,
      row.cache_read_tokens,
      row.cache_write_tokens,
      row.total_tokens,
    );
    return "inserted";
  }
  if (row.total_tokens <= existing.total_tokens) return "kept";
  db.prepare(
    `UPDATE token_events SET
      session_id = ?, model = ?, project = ?, ts = ?,
      input_tokens = ?, output_tokens = ?, reasoning_tokens = ?,
      cache_read_tokens = ?, cache_write_tokens = ?, total_tokens = ?
    WHERE event_key = ?`,
  ).run(
    row.session_id ?? null,
    row.model ?? null,
    row.project ?? null,
    row.ts,
    row.input_tokens,
    row.output_tokens,
    row.reasoning_tokens,
    row.cache_read_tokens,
    row.cache_write_tokens,
    row.total_tokens,
    row.event_key,
  );
  return "updated";
}

const ZERO_TOTALS: TokenTotals = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
};

/** Per-model sums in the window. Default `[from, to]`; rolling windows pass
 * `{ fromInclusive: false }` for a half-open `(from, to]` so an event exactly
 * `windowMs` old ages out instead of pinning the window open. */
export function sumTokenEventsByModel(
  db: DatabaseSync,
  agent: string,
  from: Date,
  to: Date,
  excludeSessionIds: string[] = [],
  opts: { fromInclusive?: boolean } = {},
): Array<{ model: string | null; sessions: Set<string>; events: number } & TokenTotals> {
  const fromOp = opts.fromInclusive === false ? ">" : ">=";
  const excluded = excludeSessionIds.filter(Boolean);
  const excludeClause =
    excluded.length > 0
      ? `AND (session_id IS NULL OR session_id NOT IN (${excluded.map(() => "?").join(", ")}))`
      : "";
  const rows = db
    .prepare(
      `SELECT model, session_id, COUNT(*) AS events,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(reasoning_tokens) AS reasoning_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cache_write_tokens) AS cache_write_tokens,
              SUM(total_tokens) AS total_tokens
       FROM token_events
       WHERE agent = ? AND ts ${fromOp} ? AND ts <= ? ${excludeClause}
       GROUP BY model, session_id`,
    )
    .all(agent, from.toISOString(), to.toISOString(), ...excluded) as Array<
    Record<string, string | number | null>
  >;

  const byModel = new Map<
    string,
    { model: string | null; sessions: Set<string>; events: number } & TokenTotals
  >();
  for (const row of rows) {
    const key = (row.model as string | null) ?? "(unknown)";
    let entry = byModel.get(key);
    if (!entry) {
      entry = { model: row.model as string | null, sessions: new Set(), events: 0, ...ZERO_TOTALS };
      byModel.set(key, entry);
    }
    entry.events += Number(row.events);
    if (typeof row.session_id === "string" && row.session_id) entry.sessions.add(row.session_id);
    entry.inputTokens += Number(row.input_tokens ?? 0);
    entry.outputTokens += Number(row.output_tokens ?? 0);
    entry.reasoningTokens += Number(row.reasoning_tokens ?? 0);
    entry.cacheReadTokens += Number(row.cache_read_tokens ?? 0);
    entry.cacheWriteTokens += Number(row.cache_write_tokens ?? 0);
    entry.totalTokens += Number(row.total_tokens ?? 0);
  }
  return [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

export interface Checkpoint {
  path: string;
  size: number;
  mtimeMs: number;
  parserVersion: string;
}

export function getCheckpoint(db: DatabaseSync, pathHash: string): Checkpoint | null {
  const row = db
    .prepare(
      "SELECT path, size, mtime_ms, parser_version FROM scan_checkpoints WHERE path_hash = ?",
    )
    .get(pathHash) as
    | { path: string; size: number; mtime_ms: number; parser_version: string }
    | undefined;
  if (!row) return null;
  return { path: row.path, size: Number(row.size), mtimeMs: Number(row.mtime_ms), parserVersion: row.parser_version };
}

export function setCheckpoint(db: DatabaseSync, pathHash: string, cp: Checkpoint): void {
  db.prepare(
    `INSERT INTO scan_checkpoints(path_hash, path, size, mtime_ms, parser_version, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path_hash) DO UPDATE SET
       path = excluded.path, size = excluded.size, mtime_ms = excluded.mtime_ms,
       parser_version = excluded.parser_version, scanned_at = excluded.scanned_at`,
  ).run(pathHash, cp.path, cp.size, cp.mtimeMs, cp.parserVersion, new Date().toISOString());
}

export function getState(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setState(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO app_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
