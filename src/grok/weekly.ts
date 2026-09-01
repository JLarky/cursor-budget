import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { getState, openLlmDb, setState } from "../llm/db.js";
import { asRecord, fetchJson, finiteNumber, type FetchFn } from "../llm/usage/http.js";
import { grokAuthLockPath, grokAuthPath } from "../llm/paths.js";
import { GROK_WEEKLY_CACHE_KEY } from "../db/keys.js";
import { asJsonObject, jsonString, parseJsonText, type JsonObject, type JsonValue } from "../json-value.js";
import { percent, type GrokWeekly, type Reading } from "./policy.js";

const CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_TOKEN_AUTH_HEADER = "xai-grok-cli";
const AUTH_SCOPE_PREFIX = "https://auth.x.ai::";

/** Soft TTL for the cached reading. Matches usage/index.ts DEFAULT_CACHE_TTL_MS. */
const READING_TTL_MS = 90_000;
/** Refresh gives up rather than fight Grok's own CLI for the lock. */
const LOCK_WAIT_MS = 750;
const LOCK_POLL_MS = 50;
/** A lock older than this was abandoned by a crashed process; safe to steal. */
const LOCK_MAX_AGE_S = 10;

export interface GrokWeeklyDeps {
  readonly home?: string;
  readonly now?: Date;
  readonly fetch?: FetchFn;
  readonly timeoutMs?: number;
  readonly db?: DatabaseSync;
  readonly forceRefresh?: boolean;
}

/**
 * @internal Never exported, never logged, never stored by llm-budget.
 * `GrokWeekly`, `GateState`, `Verdict`, and `DenyReport` have no field this
 * could inhabit, so a token cannot reach a deny message or sqlite by
 * construction rather than by review.
 */
interface Bearer {
  readonly value: string;
  readonly expiresAt: Date | null;
  /** The `https://auth.x.ai::<client_id>` key this entry lives under in auth.json. */
  readonly scopeKey: string;
  readonly refreshToken: string | null;
}

function parseDate(value: string | null): Date | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function bearerFromEntry(scopeKey: string, entry: JsonObject): Bearer | null {
  const value = jsonString(entry.key);
  if (value === null) return null;
  return {
    value,
    scopeKey,
    refreshToken: jsonString(entry.refresh_token),
    expiresAt: parseDate(jsonString(entry.expires_at)),
  };
}

function readAuthFile(home?: string): JsonObject | null {
  const path = grokAuthPath(home);
  if (!existsSync(path)) return null;
  try {
    return asJsonObject(parseJsonText(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/**
 * Picks the `https://auth.x.ai::` OIDC entry. If several exist (re-auth under
 * a different client id), the latest `expires_at` wins — deterministic
 * without guessing which client id is "current".
 */
function borrowBearer(home: string | undefined): Bearer | { readonly because: string } {
  const auth = readAuthFile(home);
  if (auth === null) {
    return { because: "no Grok auth.json — sign in with the grok CLI" };
  }
  let best: Bearer | null = null;
  for (const [key, value] of Object.entries(auth)) {
    if (!key.startsWith(AUTH_SCOPE_PREFIX)) continue;
    const entry = asJsonObject(value);
    if (entry === null) continue;
    const bearer = bearerFromEntry(key, entry);
    if (bearer === null) continue;
    if (best === null) {
      best = bearer;
      continue;
    }
    const bestExpiry = best.expiresAt?.getTime() ?? -Infinity;
    const candidateExpiry = bearer.expiresAt?.getTime() ?? -Infinity;
    if (candidateExpiry > bestExpiry) best = bearer;
  }
  if (best === null) {
    return { because: "no https://auth.x.ai OIDC entry in auth.json" };
  }
  return best;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isStaleLock(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return true;
  }
  const [pidText, epochText] = raw.split(":");
  const pid = Number(pidText);
  const epochSeconds = Number(epochText);
  if (!Number.isFinite(pid) || !processIsAlive(pid)) return true;
  if (!Number.isFinite(epochSeconds)) return true;
  return Date.now() / 1000 - epochSeconds > LOCK_MAX_AGE_S;
}

/**
 * Take `auth.json.lock` (`<pid>:<epochSeconds>`) only if it is absent, its
 * pid is dead, or its timestamp has passed. Waits at most `LOCK_WAIT_MS`.
 * Losing the race returns false, which becomes `unavailable` — a blocked
 * tool call is recoverable with an override; a corrupted auth.json is not.
 */
async function acquireLock(lockPath: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, `${process.pid}:${Math.floor(Date.now() / 1000)}`);
      closeSync(fd);
      return true;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") return false;
      if (isStaleLock(lockPath)) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch {
          // Raced with another releaser; fall through to the wait below.
        }
      }
      if (Date.now() >= deadline) return false;
      await sleep(LOCK_POLL_MS);
    }
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone; nothing to release.
  }
}

function clientIdFromScopeKey(scopeKey: string): string {
  return scopeKey.slice(AUTH_SCOPE_PREFIX.length);
}

/**
 * Refresh under Grok's own lock, then re-read.
 *
 * After a successful grant, merges only the rotated fields (`key`,
 * `refresh_token`, `expires_at`) into that scope's entry, preserving every
 * other field Grok wrote. Persisting the rotated refresh token is mandatory:
 * reusing a consumed one invalidates the Grok CLI session.
 */
async function refreshUnderGrokLock(stale: Bearer, deps: GrokWeeklyDeps): Promise<Bearer | null> {
  if (stale.refreshToken === null) return null;
  const lockPath = grokAuthLockPath(deps.home);
  const acquired = await acquireLock(lockPath, LOCK_WAIT_MS);
  if (!acquired) return null;
  try {
    // Read-after-write: the Grok CLI itself may have refreshed while we waited.
    const reread = borrowBearer(deps.home);
    if (!("because" in reread) && reread.scopeKey === stale.scopeKey) {
      const now = deps.now ?? new Date();
      if (reread.expiresAt !== null && reread.expiresAt.getTime() > now.getTime()) {
        return reread;
      }
    }

    const response = await fetchJson(
      TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: clientIdFromScopeKey(stale.scopeKey),
          refresh_token: stale.refreshToken,
        }),
      },
      { fetch: deps.fetch, timeoutMs: deps.timeoutMs },
    );
    const body = asRecord(response.json);
    const accessToken = jsonString(body?.access_token) ?? jsonString(body?.key);
    if (response.status < 200 || response.status >= 300 || accessToken === null) return null;
    const refreshToken = jsonString(body?.refresh_token) ?? stale.refreshToken;
    const expiresIn = finiteNumber(body?.expires_in);
    const expiresAtRaw = jsonString(body?.expires_at);
    const expiresAt = expiresAtRaw ?? new Date(Date.now() + (expiresIn ?? 0) * 1000).toISOString();

    const auth = readAuthFile(deps.home) ?? {};
    const existing = asJsonObject(auth[stale.scopeKey]) ?? {};
    auth[stale.scopeKey] = {
      ...existing,
      key: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresAt,
    };
    writeFileSync(grokAuthPath(deps.home), `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });

    return {
      value: accessToken,
      scopeKey: stale.scopeKey,
      refreshToken,
      expiresAt: parseDate(expiresAt),
    };
  } catch {
    return null;
  } finally {
    releaseLock(lockPath);
  }
}

function unavailableWeekly(because: string, resetsAt: string | null, now: Date): GrokWeekly {
  return {
    percent: { kind: "unavailable", because },
    resetsAt,
    planLabel: null,
    fetchedAt: now.toISOString(),
  };
}

/**
 * Boundary parse. Pure, total, never throws — every malformed or unexpected
 * shape becomes an `unmetered` or `unavailable` reading with a human-readable
 * `because`.
 *
 * `unmetered` requires a recognizable billing period, which is how we know
 * xAI actually answered rather than handed us an error body with a 200.
 */
export function parseCreditsPayload(json: JsonValue, fetchedAt: Date): GrokWeekly {
  const fetchedAtIso = fetchedAt.toISOString();
  const config = asJsonObject(asJsonObject(json)?.config);
  if (config === null) {
    return unavailableWeekly("Grok billing response was not the expected object", null, fetchedAt);
  }

  const resetsAt =
    jsonString(asJsonObject(config.currentPeriod)?.end) ?? jsonString(config.billingPeriodEnd);

  const reported = finiteNumber(config.creditUsagePercent);
  if (reported !== null) {
    const measured = percent(reported);
    if (measured !== null) {
      return {
        percent: { kind: "measured", percent: measured, source: "creditUsagePercent" },
        resetsAt,
        planLabel: null,
        fetchedAt: fetchedAtIso,
      };
    }
  }

  const cap = finiteNumber(asJsonObject(config.onDemandCap)?.val);
  if (cap !== null && cap > 0) {
    const used = finiteNumber(asJsonObject(config.onDemandUsed)?.val) ?? 0;
    const ratio = percent(Math.min(100, Math.max(0, (used / cap) * 100)));
    if (ratio !== null) {
      return {
        percent: { kind: "measured", percent: ratio, source: "onDemandRatio" },
        resetsAt,
        planLabel: null,
        fetchedAt: fetchedAtIso,
      };
    }
  }

  if (resetsAt === null) {
    return unavailableWeekly("Grok billing response had no billing period", null, fetchedAt);
  }
  return {
    percent: { kind: "unmetered", because: "Grok plan does not report a weekly credit percent" },
    resetsAt,
    planLabel: null,
    fetchedAt: fetchedAtIso,
  };
}

function parseCachedReading(value: JsonValue | undefined): Reading | null {
  const obj = asJsonObject(value);
  if (obj === null) return null;
  const kind = jsonString(obj.kind);
  if (kind === "measured") {
    const raw = finiteNumber(obj.percent);
    const source = jsonString(obj.source);
    if (raw === null || (source !== "creditUsagePercent" && source !== "onDemandRatio")) return null;
    const measured = percent(raw);
    if (measured === null) return null;
    return { kind: "measured", percent: measured, source };
  }
  if (kind === "unmetered" || kind === "unavailable") {
    return { kind, because: jsonString(obj.because) ?? "" };
  }
  return null;
}

function readCachedWeekly(db: DatabaseSync): GrokWeekly | null {
  const raw = getState(db, GROK_WEEKLY_CACHE_KEY);
  if (raw === null) return null;
  try {
    const obj = asJsonObject(parseJsonText(raw));
    if (obj === null) return null;
    const reading = parseCachedReading(obj.percent);
    const fetchedAt = jsonString(obj.fetchedAt);
    if (reading === null || fetchedAt === null) return null;
    return { percent: reading, resetsAt: jsonString(obj.resetsAt), planLabel: jsonString(obj.planLabel), fetchedAt };
  } catch {
    return null;
  }
}

function writeCachedWeekly(db: DatabaseSync, weekly: GrokWeekly): void {
  setState(db, GROK_WEEKLY_CACHE_KEY, JSON.stringify(weekly));
}

async function callCredits(
  bearer: Bearer,
  deps: GrokWeeklyDeps,
): Promise<{ kind: "ok"; json: JsonValue } | { kind: "auth" } | { kind: "error"; detail: string }> {
  try {
    const response = await fetchJson(
      CREDITS_URL,
      {
        headers: {
          Authorization: `Bearer ${bearer.value}`,
          "x-xai-token-auth": XAI_TOKEN_AUTH_HEADER,
          Accept: "application/json",
        },
      },
      { fetch: deps.fetch, timeoutMs: deps.timeoutMs },
    );
    if (response.status === 401 || response.status === 403) return { kind: "auth" };
    if (response.status < 200 || response.status >= 300) {
      return { kind: "error", detail: `Grok billing API HTTP ${response.status}` };
    }
    if (response.json === null) return { kind: "error", detail: "Grok billing API returned non-JSON" };
    return { kind: "ok", json: response.json };
  } catch (error) {
    return { kind: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Everything the gate needs to know about xAI, in one call.
 *
 * Never throws and never returns a stale percent: a failed refresh returns
 * `unavailable` rather than replaying the old number, so a broken credential
 * shows up immediately instead of coasting on a cached reading. Never
 * persists the bearer to sqlite.
 */
export async function readGrokWeekly(deps: GrokWeeklyDeps = {}): Promise<GrokWeekly> {
  const now = deps.now ?? new Date();
  const db = deps.db ?? openLlmDb(deps.home);

  if (!deps.forceRefresh) {
    const cached = readCachedWeekly(db);
    if (cached !== null) {
      const ageMs = now.getTime() - new Date(cached.fetchedAt).getTime();
      if (ageMs >= 0 && ageMs < READING_TTL_MS) return cached;
    }
  }

  const found = borrowBearer(deps.home);
  if ("because" in found) return unavailableWeekly(found.because, null, now);

  let bearer = found;
  if (bearer.expiresAt !== null && bearer.expiresAt.getTime() <= now.getTime()) {
    const refreshed = await refreshUnderGrokLock(bearer, deps);
    if (refreshed === null) {
      return unavailableWeekly("Grok credential expired and refresh failed", null, now);
    }
    bearer = refreshed;
  }

  let result = await callCredits(bearer, deps);
  if (result.kind === "auth") {
    const refreshed = await refreshUnderGrokLock(bearer, deps);
    if (refreshed === null) {
      return unavailableWeekly("Grok credential rejected (401) and refresh failed", null, now);
    }
    result = await callCredits(refreshed, deps);
  }
  if (result.kind === "error") {
    return unavailableWeekly(result.detail, null, now);
  }
  if (result.kind === "auth") {
    return unavailableWeekly("Grok credential rejected (401) after refresh", null, now);
  }

  const weekly = parseCreditsPayload(result.json, now);
  writeCachedWeekly(db, weekly);
  return weekly;
}

/**
 * `settings.subscription_tier_display` from GET /v1/settings. Best-effort and
 * separate from `readGrokWeekly`: a plan label is decoration and must never
 * turn a good reading into unavailable.
 */
export async function readGrokPlanLabel(deps: GrokWeeklyDeps = {}): Promise<string | null> {
  const found = borrowBearer(deps.home);
  if ("because" in found) return null;
  try {
    const response = await fetchJson(
      SETTINGS_URL,
      {
        headers: {
          Authorization: `Bearer ${found.value}`,
          "x-xai-token-auth": XAI_TOKEN_AUTH_HEADER,
          Accept: "application/json",
        },
      },
      { fetch: deps.fetch, timeoutMs: deps.timeoutMs },
    );
    if (response.status < 200 || response.status >= 300) return null;
    return jsonString(asRecord(response.json)?.subscription_tier_display);
  } catch {
    return null;
  }
}