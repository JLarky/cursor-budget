import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { llmDbPath } from "./paths.js";

export type { DatabaseSync };

/**
 * Key/value state only — override deadlines live here. Usage percentages are
 * read live from the Paseo daemon; nothing token-shaped is stored anymore.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

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
