import { getCursorPeriodUsage } from "../accounting/cursor-api.js";

/** Print billed Cursor period usage as JSON (live network; bypasses fresh cache). */
export async function spendingCommand(): Promise<string> {
  const result = await getCursorPeriodUsage({ forceRefresh: true });
  return `${JSON.stringify(
    {
      source: result.source,
      stale: result.stale,
      fetchedAt: result.fetchedAt.toISOString(),
      ageMs: result.ageMs,
      ...(result.refreshError ? { refreshError: result.refreshError } : {}),
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
    },
    null,
    2,
  )}\n`;
}
