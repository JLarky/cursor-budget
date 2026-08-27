import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { dbPath } from "../paths.js";
import { SCHEMA_SQL } from "./schema.js";
import { CURSOR_OVERRIDE_KEY } from "./keys.js";

export interface UsageRow {
  timestamp: string;
  conversation_id?: string;
  generation_id?: string;
  event_type: string;
  model?: string;
  dedupe_key: string;
}

let cached: DatabaseSync | null = null;

export function openDb(home?: string): DatabaseSync {
  if (cached && !home) return cached;
  const path = dbPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  if (!home) cached = db;
  return db;
}

export function getCursorOverride(db: DatabaseSync): string | null {
  return getState(db, CURSOR_OVERRIDE_KEY);
}

export function setCursorOverride(db: DatabaseSync, value: string): void {
  setState(db, CURSOR_OVERRIDE_KEY, value);
}

export function withImmediate<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function insertUsageEvent(db: DatabaseSync, row: UsageRow): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO usage_events (
        timestamp, conversation_id, generation_id, event_type, model, dedupe_key
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.timestamp,
      row.conversation_id ?? null,
      row.generation_id ?? null,
      row.event_type,
      row.model ?? null,
      row.dedupe_key,
    );
  return Number(result.changes) > 0;
}

/** Count recorded events in `[from, to]` (backstop rate limit). */
export function countEvents(
  db: DatabaseSync,
  from: Date,
  to: Date,
  excludeConversationIds: string[] = [],
): number {
  const excluded = excludeConversationIds.filter(Boolean);
  const placeholders = excluded.map(() => "?").join(", ");
  const excludeClause =
    excluded.length > 0
      ? `AND (conversation_id IS NULL OR conversation_id NOT IN (${placeholders}))`
      : "";
  // SAFETY: SELECT COUNT(*) AS n; node:sqlite returns number | bigint for that column.
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM usage_events
       WHERE timestamp >= ? AND timestamp <= ? ${excludeClause}`,
    )
    .get(from.toISOString(), to.toISOString(), ...excluded) as { n: number | bigint };
  return Number(row.n);
}

export function listRecentEvents(db: DatabaseSync, limit = 20): UsageRow[] {
  const rows = db
    .prepare(
      `SELECT timestamp, conversation_id, generation_id, event_type, model, dedupe_key
       FROM usage_events
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(limit);
  return rows.map((row) => ({
    timestamp: `${row.timestamp ?? ""}`,
    conversation_id: row.conversation_id == null ? undefined : `${row.conversation_id}`,
    generation_id: row.generation_id == null ? undefined : `${row.generation_id}`,
    event_type: `${row.event_type ?? ""}`,
    model: row.model == null ? undefined : `${row.model}`,
    dedupe_key: `${row.dedupe_key ?? ""}`,
  }));
}

export function getState(db: DatabaseSync, key: string): string | null {
  // SAFETY: SELECT value FROM app_state; missing rows are undefined.
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

export function hasWarning(
  db: DatabaseSync,
  windowId: string,
  threshold: number,
  periodKey: string,
): boolean {
  // SAFETY: SELECT 1 AS ok; missing rows are undefined.
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM warning_emissions WHERE window_id = ? AND threshold = ? AND period_key = ?",
    )
    .get(windowId, threshold, periodKey) as { ok: number } | undefined;
  return Boolean(row);
}

export function markWarning(
  db: DatabaseSync,
  windowId: string,
  threshold: number,
  periodKey: string,
  firedAt: string,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO warning_emissions(window_id, threshold, period_key, fired_at) VALUES (?, ?, ?, ?)",
  ).run(windowId, threshold, periodKey, firedAt);
}

export function makeDedupeKey(
  generationId: string | undefined,
  eventType: string,
  content: string,
  opts?: { conversationId?: string; timestamp?: string | Date },
): string {
  const gen = generationId?.trim() || "-";
  let scope = gen;
  // Without a generation id, identical content would collide forever. Scope by
  // conversation + minute bucket so a later identical prompt still counts.
  if (gen === "-") {
    const ts = opts?.timestamp != null ? new Date(opts.timestamp) : new Date();
    const minute = Number.isNaN(ts.getTime())
      ? Math.floor(Date.now() / 60_000)
      : Math.floor(ts.getTime() / 60_000);
    scope = `${opts?.conversationId?.trim() || "-"}@${minute}`;
  }
  return createHash("sha256").update(`${scope}\0${eventType}\0${content}`).digest("hex");
}
