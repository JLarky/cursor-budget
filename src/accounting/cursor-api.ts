import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { getState, openDb, setState } from "../db/client.js";
import {
  asJsonObject,
  emptyJsonObject,
  jsonBoolean,
  jsonFiniteNumber,
  jsonString,
  parseJsonText,
  type JsonObject,
  type JsonValue,
} from "../json-value.js";
import { cliAuthPath } from "../paths.js";

const PERIOD_USAGE_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

/** Default fetch abort for GetCurrentPeriodUsage (hook paths cannot hang). */
export const DEFAULT_FETCH_TIMEOUT_MS = 5000;

/** Default freshness window for the persisted usage snapshot. */
export const DEFAULT_CACHE_TTL_MS = 90_000;

/** `app_state` key for the last good normalized period-usage snapshot. */
export const PERIOD_USAGE_CACHE_KEY = "cursor_period_usage_v1";

export interface CliAuthFile {
  accessToken: string;
  refreshToken?: string;
}

export interface CursorPlanUsage {
  /** Cents toward the included pool (includedSpend + bonusSpend when present). */
  totalSpendCents: number;
  includedSpendCents: number;
  bonusSpendCents: number;
  remainingCents: number | null;
  limitCents: number | null;
  totalSpendUsd: number;
  includedSpendUsd: number;
  bonusSpendUsd: number;
  remainingUsd: number | null;
  limitUsd: number | null;
  /**
   * Dashboard "Cursor Models" / auto-mode meter.
   * Scale is **0–100** (e.g. `1.298` means ~1.3%), not 0–1.
   * Distinct from `config.warnings` which uses 0–1 fractions.
   * `null` when Cursor omits or renames the field — never treat as 0.
   */
  autoPercentUsed: number | null;
  /**
   * Dashboard "Other Models" / API meter.
   * Scale is **0–100** (not 0–1). `null` when absent/unparseable — never treat as 0.
   */
  apiPercentUsed: number | null;
  /**
   * Combined meter on a **0–100** scale (not 0–1).
   * `null` when absent/unparseable — never treat as 0.
   */
  totalPercentUsed: number | null;
  remainingBonus: boolean;
  bonusTooltip: string | null;
}

export interface CursorSpendLimitUsage {
  limitType: string | null;
  totalSpendCents: number | null;
  individualLimitCents: number | null;
  individualUsedCents: number | null;
  individualRemainingCents: number | null;
  pooledLimitCents: number | null;
  pooledUsedCents: number | null;
  pooledRemainingCents: number | null;
}

/**
 * Normalized snapshot of Cursor's current billing-period usage.
 * Omits the API `raw` blob so it can be persisted cheaply across hook processes.
 */
export interface CursorPeriodUsage {
  /** Null when Cursor omits/renames the field; does not abort the rest of the parse. */
  billingCycleStart: Date | null;
  /** Null when Cursor omits/renames the field; does not abort the rest of the parse. */
  billingCycleEnd: Date | null;
  planUsage: CursorPlanUsage;
  spendLimitUsage: CursorSpendLimitUsage;
  displayThreshold: number | null;
  enabled: boolean | null;
  /** e.g. "You've used 6% of your included usage" (spend÷limit style). */
  displayMessage: string | null;
  autoModelSelectedDisplayMessage: string | null;
  namedModelSelectedDisplayMessage: string | null;
  autoBucketModels: string[];
}

export type CursorPeriodUsageSource = "network" | "cache" | "stale-cache";

/** Result of {@link getCursorPeriodUsage}, including cache provenance. */
export interface CursorPeriodUsageResult {
  usage: CursorPeriodUsage;
  /** Where the returned snapshot came from. */
  source: CursorPeriodUsageSource;
  /** Wall-clock time the snapshot was fetched from the network and stored. */
  fetchedAt: Date;
  /** Age of the stored snapshot relative to `now` (ms). */
  ageMs: number;
  /** True when a refresh was needed but failed and a prior snapshot was returned. */
  stale: boolean;
  /** Present when `stale` — the refresh error (timeout / HTTP / network / parse). */
  refreshError?: string;
}

export interface GetCursorPeriodUsageOptions {
  /** Override home for `~/.config/cursor/auth.json` and the SQLite cache DB. */
  home?: string;
  /**
   * Bearer token. Defaults to `CURSOR_ACCESS_TOKEN` env, then CLI `auth.json`.
   * Never log or persist this value from callers.
   */
  accessToken?: string;
  /** Override the Connect RPC URL (tests / proxies). */
  url?: string;
  /**
   * Fetch abort timeout in ms. Default {@link DEFAULT_FETCH_TIMEOUT_MS}.
   * Pass `0` to disable.
   */
  timeoutMs?: number;
  /**
   * Cache TTL in ms. Default {@link DEFAULT_CACHE_TTL_MS}.
   * Pass `0` to always attempt a network refresh (still falls back to stale cache on failure).
   */
  cacheTtlMs?: number;
  /**
   * Bypass a fresh cache hit and force a network fetch.
   * On failure, still returns a stale cached snapshot when one exists.
   */
  forceRefresh?: boolean;
  /** Injected DB (tests). Defaults to `openDb(home)`. */
  db?: DatabaseSync;
  /** Wall clock override (tests). */
  now?: Date;
  fetch?: typeof fetch;
}

export class CursorAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorAuthError";
  }
}

/** Non-OK HTTP response from Cursor's usage API. */
export class CursorApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Cursor usage API HTTP ${status}: ${truncate(body, 200)}`);
    this.name = "CursorApiError";
    this.status = status;
    this.body = body;
  }
}

/** Response body could not be parsed or lacked the expected JSON shape. */
export class CursorParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorParseError";
  }
}

/** Fetch aborted because {@link GetCursorPeriodUsageOptions.timeoutMs} elapsed. */
export class CursorTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Cursor usage API timed out after ${timeoutMs}ms`);
    this.name = "CursorTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * No usable snapshot: network refresh failed and there is nothing in the cache.
 * Callers that gate the editor should treat this as "unknown", not "over budget".
 */
export class CursorUsageUnavailableError extends Error {
  readonly causeError?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CursorUsageUnavailableError";
    this.causeError = cause;
  }
}

interface CachedPeriodUsageRow {
  fetchedAt: string;
  usage: SerializedPeriodUsage;
}

interface SerializedPeriodUsage {
  billingCycleStart: string | null;
  billingCycleEnd: string | null;
  planUsage: CursorPlanUsage;
  spendLimitUsage: CursorSpendLimitUsage;
  displayThreshold: number | null;
  enabled: boolean | null;
  displayMessage: string | null;
  autoModelSelectedDisplayMessage: string | null;
  namedModelSelectedDisplayMessage: string | null;
  autoBucketModels: string[];
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function centsToUsd(cents: number): number {
  return cents / 100;
}

function asNumber(value: JsonValue | null | undefined): number | null {
  return jsonFiniteNumber(value);
}

function asString(value: JsonValue | null | undefined): string | null {
  return jsonString(value);
}

function asBoolean(value: JsonValue | null | undefined): boolean | null {
  return jsonBoolean(value);
}

function stringList(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = jsonString(item);
    if (s !== null) out.push(s);
  }
  return out;
}

/**
 * Parse Cursor's billing-cycle fields (unix ms as string or number).
 * Returns `null` when absent/unparseable — cycle dates are optional.
 */
export function parseCursorTimestamp(value: JsonValue | null | undefined): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const n = asNumber(value);
  if (n == null) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export function readCliAuth(home = homedir()): CliAuthFile {
  const path = cliAuthPath(home);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    throw new CursorAuthError(
      code === "ENOENT"
        ? `No Cursor CLI auth at ${path}. Sign in with cursor-agent, or pass accessToken / CURSOR_ACCESS_TOKEN.`
        : `Failed to read Cursor CLI auth at ${path}`,
    );
  }
  let parsed: JsonValue;
  try {
    parsed = parseJsonText(raw);
  } catch {
    throw new CursorAuthError(`Invalid JSON in ${path}`);
  }
  const obj = asJsonObject(parsed);
  const accessToken = obj ? jsonString(obj.accessToken) : null;
  if (!obj || !accessToken) {
    throw new CursorAuthError(`Missing accessToken in ${path}`);
  }
  const refreshToken = jsonString(obj.refreshToken);
  if (refreshToken === null) return { accessToken };
  return { accessToken, refreshToken };
}

/**
 * Expiry of a Cursor session JWT, read from the `exp` claim.
 *
 * The payload is decoded, never verified — we only need to know when the
 * credential dies, so we can warn before the guard starts denying on auth
 * failure. Returns `null` for anything that is not a JWT carrying a usable
 * `exp`, so an unrecognised token shape simply means "no warning", never a
 * crash. The token itself is never logged or persisted.
 */
export function tokenExpiry(token: string): Date | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = asJsonObject(parseJsonText(Buffer.from(payload, "base64url").toString("utf8")));
    if (!claims) return null;
    return parseCursorTimestamp(claims.exp);
  } catch {
    return null;
  }
}

/** Expiry of whichever credential `resolveAccessToken` would use, or null. */
export function readAuthExpiry(home?: string): Date | null {
  try {
    return tokenExpiry(resolveAccessToken({ home }));
  } catch {
    return null;
  }
}

export function resolveAccessToken(options: GetCursorPeriodUsageOptions = {}): string {
  if (options.accessToken?.trim()) return options.accessToken.trim();
  const fromEnv = process.env.CURSOR_ACCESS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return readCliAuth(options.home).accessToken;
}

function parsePlanUsage(raw: JsonObject): CursorPlanUsage {
  const totalSpendCents = asNumber(raw.totalSpend) ?? 0;
  const includedSpendCents = asNumber(raw.includedSpend) ?? totalSpendCents;
  const bonusSpendCents = asNumber(raw.bonusSpend) ?? 0;
  const remainingCents = asNumber(raw.remaining);
  const limitCents = asNumber(raw.limit);
  return {
    totalSpendCents,
    includedSpendCents,
    bonusSpendCents,
    remainingCents,
    limitCents,
    totalSpendUsd: centsToUsd(totalSpendCents),
    includedSpendUsd: centsToUsd(includedSpendCents),
    bonusSpendUsd: centsToUsd(bonusSpendCents),
    remainingUsd: remainingCents == null ? null : centsToUsd(remainingCents),
    limitUsd: limitCents == null ? null : centsToUsd(limitCents),
    // Absent/renamed meters stay null — defaulting to 0 would fail-open a percent gate.
    autoPercentUsed: asNumber(raw.autoPercentUsed),
    apiPercentUsed: asNumber(raw.apiPercentUsed),
    totalPercentUsed: asNumber(raw.totalPercentUsed),
    remainingBonus: asBoolean(raw.remainingBonus) ?? false,
    bonusTooltip: asString(raw.bonusTooltip),
  };
}

function parseSpendLimitUsage(raw: JsonValue | null | undefined): CursorSpendLimitUsage {
  const obj = asJsonObject(raw) ?? emptyJsonObject();
  return {
    limitType: asString(obj.limitType),
    totalSpendCents: asNumber(obj.totalSpend),
    individualLimitCents: asNumber(obj.individualLimit),
    individualUsedCents: asNumber(obj.individualUsed),
    individualRemainingCents: asNumber(obj.individualRemaining),
    pooledLimitCents: asNumber(obj.pooledLimit),
    pooledUsedCents: asNumber(obj.pooledUsed),
    pooledRemainingCents: asNumber(obj.pooledRemaining),
  };
}

/** Map Connect RPC JSON into {@link CursorPeriodUsage} (no `raw` blob). */
export function normalizePeriodUsage(raw: JsonValue): CursorPeriodUsage {
  const parsed = asJsonObject(raw);
  // Non-objects throw; JSON arrays keep the previous empty-object fallback.
  if (parsed === null && !Array.isArray(raw)) {
    throw new CursorParseError("Expected JSON object from GetCurrentPeriodUsage");
  }
  const body = parsed ?? emptyJsonObject();
  const planRaw = asJsonObject(body.planUsage) ?? emptyJsonObject();
  const autoBucketModels = stringList(body.autoBucketModels);

  return {
    billingCycleStart: parseCursorTimestamp(body.billingCycleStart),
    billingCycleEnd: parseCursorTimestamp(body.billingCycleEnd),
    planUsage: parsePlanUsage(planRaw),
    spendLimitUsage: parseSpendLimitUsage(body.spendLimitUsage),
    displayThreshold: asNumber(body.displayThreshold),
    enabled: asBoolean(body.enabled),
    displayMessage: asString(body.displayMessage),
    autoModelSelectedDisplayMessage: asString(body.autoModelSelectedDisplayMessage),
    namedModelSelectedDisplayMessage: asString(body.namedModelSelectedDisplayMessage),
    autoBucketModels,
  };
}

export function serializePeriodUsage(usage: CursorPeriodUsage): SerializedPeriodUsage {
  return {
    billingCycleStart: usage.billingCycleStart?.toISOString() ?? null,
    billingCycleEnd: usage.billingCycleEnd?.toISOString() ?? null,
    planUsage: usage.planUsage,
    spendLimitUsage: usage.spendLimitUsage,
    displayThreshold: usage.displayThreshold,
    enabled: usage.enabled,
    displayMessage: usage.displayMessage,
    autoModelSelectedDisplayMessage: usage.autoModelSelectedDisplayMessage,
    namedModelSelectedDisplayMessage: usage.namedModelSelectedDisplayMessage,
    autoBucketModels: usage.autoBucketModels,
  };
}

export function deserializePeriodUsage(raw: SerializedPeriodUsage): CursorPeriodUsage {
  return {
    billingCycleStart: raw.billingCycleStart ? new Date(raw.billingCycleStart) : null,
    billingCycleEnd: raw.billingCycleEnd ? new Date(raw.billingCycleEnd) : null,
    planUsage: raw.planUsage,
    spendLimitUsage: raw.spendLimitUsage,
    displayThreshold: raw.displayThreshold,
    enabled: raw.enabled,
    displayMessage: raw.displayMessage,
    autoModelSelectedDisplayMessage: raw.autoModelSelectedDisplayMessage,
    namedModelSelectedDisplayMessage: raw.namedModelSelectedDisplayMessage,
    autoBucketModels: Array.isArray(raw.autoBucketModels) ? raw.autoBucketModels : [],
  };
}

function cachedPlanUsage(raw: JsonObject): CursorPlanUsage {
  const totalSpendCents = asNumber(raw.totalSpendCents) ?? 0;
  const includedSpendCents = asNumber(raw.includedSpendCents) ?? totalSpendCents;
  const bonusSpendCents = asNumber(raw.bonusSpendCents) ?? 0;
  const remainingCents = asNumber(raw.remainingCents);
  const limitCents = asNumber(raw.limitCents);
  return {
    totalSpendCents,
    includedSpendCents,
    bonusSpendCents,
    remainingCents,
    limitCents,
    totalSpendUsd: asNumber(raw.totalSpendUsd) ?? centsToUsd(totalSpendCents),
    includedSpendUsd: asNumber(raw.includedSpendUsd) ?? centsToUsd(includedSpendCents),
    bonusSpendUsd: asNumber(raw.bonusSpendUsd) ?? centsToUsd(bonusSpendCents),
    remainingUsd: asNumber(raw.remainingUsd) ?? (remainingCents == null ? null : centsToUsd(remainingCents)),
    limitUsd: asNumber(raw.limitUsd) ?? (limitCents == null ? null : centsToUsd(limitCents)),
    autoPercentUsed: asNumber(raw.autoPercentUsed),
    apiPercentUsed: asNumber(raw.apiPercentUsed),
    totalPercentUsed: asNumber(raw.totalPercentUsed),
    remainingBonus: asBoolean(raw.remainingBonus) ?? false,
    bonusTooltip: asString(raw.bonusTooltip),
  };
}

function cachedSpendLimitUsage(raw: JsonObject): CursorSpendLimitUsage {
  return {
    limitType: asString(raw.limitType),
    totalSpendCents: asNumber(raw.totalSpendCents),
    individualLimitCents: asNumber(raw.individualLimitCents),
    individualUsedCents: asNumber(raw.individualUsedCents),
    individualRemainingCents: asNumber(raw.individualRemainingCents),
    pooledLimitCents: asNumber(raw.pooledLimitCents),
    pooledUsedCents: asNumber(raw.pooledUsedCents),
    pooledRemainingCents: asNumber(raw.pooledRemainingCents),
  };
}

function serializedUsageFromJson(raw: JsonObject): SerializedPeriodUsage {
  return {
    billingCycleStart: jsonString(raw.billingCycleStart),
    billingCycleEnd: jsonString(raw.billingCycleEnd),
    planUsage: cachedPlanUsage(asJsonObject(raw.planUsage) ?? emptyJsonObject()),
    spendLimitUsage: cachedSpendLimitUsage(asJsonObject(raw.spendLimitUsage) ?? emptyJsonObject()),
    displayThreshold: asNumber(raw.displayThreshold),
    enabled: asBoolean(raw.enabled),
    displayMessage: asString(raw.displayMessage),
    autoModelSelectedDisplayMessage: asString(raw.autoModelSelectedDisplayMessage),
    namedModelSelectedDisplayMessage: asString(raw.namedModelSelectedDisplayMessage),
    autoBucketModels: stringList(raw.autoBucketModels),
  };
}

export function readCachedPeriodUsage(db: DatabaseSync): { usage: CursorPeriodUsage; fetchedAt: Date } | null {
  const raw = getState(db, PERIOD_USAGE_CACHE_KEY);
  if (!raw) return null;
  let parsed: JsonValue;
  try {
    parsed = parseJsonText(raw);
  } catch {
    return null;
  }
  const row = asJsonObject(parsed);
  if (!row) return null;
  const fetchedAtRaw = jsonString(row.fetchedAt);
  const usageRaw = asJsonObject(row.usage);
  if (fetchedAtRaw === null || usageRaw === null) return null;
  const fetchedAt = new Date(fetchedAtRaw);
  if (Number.isNaN(fetchedAt.getTime())) return null;
  return { usage: deserializePeriodUsage(serializedUsageFromJson(usageRaw)), fetchedAt };
}

export function writeCachedPeriodUsage(db: DatabaseSync, usage: CursorPeriodUsage, fetchedAt: Date): void {
  const row: CachedPeriodUsageRow = {
    fetchedAt: fetchedAt.toISOString(),
    usage: serializePeriodUsage(usage),
  };
  setState(db, PERIOD_USAGE_CACHE_KEY, JSON.stringify(row));
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * Fetch once from the network (no cache). Throws on timeout / HTTP / parse / auth.
 * Used internally and by tests; prefer {@link getCursorPeriodUsage} for callers.
 */
export async function fetchCursorPeriodUsage(
  options: GetCursorPeriodUsageOptions = {},
): Promise<CursorPeriodUsage> {
  const accessToken = resolveAccessToken(options);
  const url = options.url ?? PERIOD_USAGE_URL;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
      signal,
    });
  } catch (error) {
    // Prefer signal.aborted: Node's fetch rejects TimeoutError (not AbortError) for
    // AbortSignal.timeout(). Name sniffing alone misses the real production path.
    if (timeoutMs > 0 && signal?.aborted) {
      throw new CursorTimeoutError(timeoutMs);
    }
    throw error;
  }

  const text = await response.text();
  if (!response.ok) {
    throw new CursorApiError(response.status, text);
  }

  let json: JsonValue;
  try {
    json = parseJsonText(text);
  } catch {
    throw new CursorParseError(`Non-JSON body from GetCurrentPeriodUsage: ${truncate(text, 200)}`);
  }

  return normalizePeriodUsage(json);
}

/**
 * Fetch current Cursor billing-period usage (dashboard spending meters).
 *
 * Auth: Bearer token from `options.accessToken`, else `CURSOR_ACCESS_TOKEN`,
 * else `~/.config/cursor/auth.json` (Cursor Agent CLI).
 *
 * Caches the normalized snapshot in SQLite `app_state` so fresh hook processes
 * can reuse it. On refresh failure, returns the last good snapshot as stale
 * rather than throwing — only throws {@link CursorUsageUnavailableError} when
 * there is nothing usable cached. Never persists the access token.
 *
 * `planUsage.autoPercentUsed` ≈ Cursor Models; `apiPercentUsed` ≈ Other Models
 * (both **0–100** scale; see {@link CursorPlanUsage}).
 */
export async function getCursorPeriodUsage(
  options: GetCursorPeriodUsageOptions = {},
): Promise<CursorPeriodUsageResult> {
  const now = options.now ?? new Date();
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const db = options.db ?? openDb(options.home);
  const cached = readCachedPeriodUsage(db);

  if (cached && !options.forceRefresh) {
    const ageMs = now.getTime() - cached.fetchedAt.getTime();
    if (ageMs >= 0 && ageMs < cacheTtlMs) {
      return {
        usage: cached.usage,
        source: "cache",
        fetchedAt: cached.fetchedAt,
        ageMs,
        stale: false,
      };
    }
  }

  try {
    const usage = await fetchCursorPeriodUsage(options);
    writeCachedPeriodUsage(db, usage, now);
    return {
      usage,
      source: "network",
      fetchedAt: now,
      ageMs: 0,
      stale: false,
    };
  } catch (error) {
    if (cached) {
      const ageMs = Math.max(0, now.getTime() - cached.fetchedAt.getTime());
      return {
        usage: cached.usage,
        source: "stale-cache",
        fetchedAt: cached.fetchedAt,
        ageMs,
        stale: true,
        refreshError: errorMessage(error),
      };
    }
    throw new CursorUsageUnavailableError(
      `Cursor usage unavailable and no cached snapshot: ${errorMessage(error)}`,
      error,
    );
  }
}
