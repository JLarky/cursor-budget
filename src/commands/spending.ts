import { getCursorPeriodUsage, type CursorPeriodUsageResult } from "../accounting/cursor-api.js";

type SpendingPayload = {
  source: CursorPeriodUsageResult["source"];
  stale: boolean;
  fetchedAt: string;
  ageMs: number;
  refreshError?: string;
  billingCycleStart: string | null;
  billingCycleEnd: string | null;
  planUsage: CursorPeriodUsageResult["usage"]["planUsage"];
  spendLimitUsage: CursorPeriodUsageResult["usage"]["spendLimitUsage"];
  displayThreshold: number | null;
  enabled: boolean | null;
  displayMessage: string | null;
  autoModelSelectedDisplayMessage: string | null;
  namedModelSelectedDisplayMessage: string | null;
  autoBucketModels: string[];
};

/** Print billed Cursor period usage as JSON (live network; bypasses fresh cache). */
export async function spendingCommand(): Promise<string> {
  const result = await getCursorPeriodUsage({ forceRefresh: true });
  const payload: SpendingPayload = {
    source: result.source,
    stale: result.stale,
    fetchedAt: result.fetchedAt.toISOString(),
    ageMs: result.ageMs,
    billingCycleStart: result.usage.billingCycleStart?.toISOString() ?? null,
    billingCycleEnd: result.usage.billingCycleEnd?.toISOString() ?? null,
    planUsage: result.usage.planUsage,
    spendLimitUsage: result.usage.spendLimitUsage,
    displayThreshold: result.usage.displayThreshold,
    enabled: result.usage.enabled,
    displayMessage: result.usage.displayMessage,
    autoModelSelectedDisplayMessage: result.usage.autoModelSelectedDisplayMessage,
    namedModelSelectedDisplayMessage: result.usage.namedModelSelectedDisplayMessage,
    autoBucketModels: result.usage.autoBucketModels,
  };
  if (result.refreshError) payload.refreshError = result.refreshError;
  return `${JSON.stringify(payload, null, 2)}\n`;
}
