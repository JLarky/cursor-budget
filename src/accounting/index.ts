import type { Config } from "../config.js";
import { LocalEventAccountingProvider } from "./local.js";
import type { AccountingProvider } from "./types.js";

export type { AccountingProvider, CursorHookEvent } from "./types.js";
export {
  CursorApiError,
  CursorAuthError,
  CursorParseError,
  CursorTimeoutError,
  CursorUsageUnavailableError,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
  PERIOD_USAGE_CACHE_KEY,
  deserializePeriodUsage,
  fetchCursorPeriodUsage,
  getCursorPeriodUsage,
  normalizePeriodUsage,
  parseCursorTimestamp,
  readCachedPeriodUsage,
  readCliAuth,
  resolveAccessToken,
  serializePeriodUsage,
  writeCachedPeriodUsage,
} from "./cursor-api.js";
export type {
  CliAuthFile,
  CursorPeriodUsage,
  CursorPeriodUsageResult,
  CursorPeriodUsageSource,
  CursorPlanUsage,
  CursorSpendLimitUsage,
  GetCursorPeriodUsageOptions,
} from "./cursor-api.js";

export function getProvider(config: Config, home?: string): AccountingProvider {
  return new LocalEventAccountingProvider(config, home);
}
