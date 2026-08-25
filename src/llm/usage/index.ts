import { getState, openLlmDb, setState, type DatabaseSync } from "../db.js";
import { fetchClaudeUsage } from "./claude.js";
import { fetchCodexUsage } from "./codex.js";
import type { FetchFn } from "./http.js";
import { asRecord } from "./http.js";
import type { ProviderUsage, UsageSnapshot } from "./types.js";

export type {
  ProviderUsage,
  UsageFetcher,
  UsageSnapshot,
  UsageWindow,
} from "./types.js";
export { emptySnapshot, errored, providerUsage, unavailable } from "./types.js";
export { fetchClaudeUsage } from "./claude.js";
export { fetchCodexUsage } from "./codex.js";

/** Soft TTL before a hook process hits Anthropic / OpenAI again. */
export const DEFAULT_CACHE_TTL_MS = 90_000;

const CACHE_KEY = "provider_usage_v1";

export interface FetchDirectUsageOptions {
  home?: string;
  now?: Date;
  fetch?: FetchFn;
  timeoutMs?: number;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  db?: DatabaseSync;
  claudeHome?: string;
  codexHome?: string;
  platform?: NodeJS.Platform;
}

function readCache(db: DatabaseSync): UsageSnapshot | null {
  const raw = getState(db, CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as UsageSnapshot;
    if (!parsed || typeof parsed.fetchedAt !== "string" || !Array.isArray(parsed.providers)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(db: DatabaseSync, snapshot: UsageSnapshot): void {
  setState(db, CACHE_KEY, JSON.stringify(snapshot));
}

function isFresh(snapshot: UsageSnapshot, now: Date, ttlMs: number): boolean {
  const fetchedAt = new Date(snapshot.fetchedAt);
  if (Number.isNaN(fetchedAt.getTime())) return false;
  const age = now.getTime() - fetchedAt.getTime();
  return age >= 0 && age < ttlMs;
}

function looksLikeSnapshot(value: unknown): value is UsageSnapshot {
  const rec = asRecord(value);
  return Boolean(rec && typeof rec.fetchedAt === "string" && Array.isArray(rec.providers));
}

/**
 * Fetch Claude Code + Codex usage from the vendor APIs.
 *
 * Never throws for expected failures: a missing login or a down API becomes
 * an `unavailable` / `error` provider entry so the guard can fail closed.
 * Caches the snapshot in the llm-budget sqlite store (no tokens stored).
 */
export async function fetchDirectUsage(
  options: FetchDirectUsageOptions = {},
): Promise<UsageSnapshot> {
  const now = options.now ?? new Date();
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const db = options.db ?? openLlmDb(options.home);
  const cached = readCache(db);
  if (cached && !options.forceRefresh && isFresh(cached, now, ttl) && looksLikeSnapshot(cached)) {
    return cached;
  }

  const [claude, codex] = await Promise.all([
    fetchClaudeUsage(options),
    fetchCodexUsage(options),
  ]);
  const snapshot: UsageSnapshot = {
    fetchedAt: now.toISOString(),
    providers: [claude, codex],
  };
  writeCache(db, snapshot);
  return snapshot;
}

/** Test helper: persist a snapshot as if a previous fetch wrote it. */
export function writeUsageCache(db: DatabaseSync, snapshot: UsageSnapshot): void {
  writeCache(db, snapshot);
}

export function isUnavailable(provider: ProviderUsage): boolean {
  return provider.status !== "available" || provider.windows.length === 0;
}
