import { getCursorPeriodUsage, getProvider } from "../accounting/index.js";
import {
  formatAge,
  formatNullablePercent,
  formatUsd,
} from "../budget/evaluator.js";
import { rollingHour } from "../budget/windows.js";
import { loadConfigForRead } from "../config.js";
import { getState, openDb } from "../db/client.js";
import { configPath } from "../paths.js";

export async function statusCommand(home?: string): Promise<string> {
  const { config, warning } = loadConfigForRead(home);
  const provider = getProvider(config, home);
  const now = new Date();
  const hourWindow = rollingHour(now);
  const eventsLastHour = await provider.countEvents(hourWindow);

  let periodLines: string[] = ["Period usage: unavailable"];
  try {
    const result = await getCursorPeriodUsage({
      home,
      cacheTtlMs: config.quota.cacheTtlMs,
      now,
    });
    const plan = result.usage.planUsage;
    const reset = result.usage.billingCycleEnd;
    periodLines = [
      "Cursor Models (auto):",
      `  ${formatNullablePercent(plan.autoPercentUsed)}  (block at ${config.quota.cursorModelsBlockAtPercent}%)`,
      "Other Models (api):",
      `  ${formatNullablePercent(plan.apiPercentUsed)}  (block at ${config.quota.otherModelsBlockAtPercent}%)`,
      "Period spend:",
      plan.limitUsd != null
        ? `  ${formatUsd(plan.totalSpendUsd)} / ${formatUsd(plan.limitUsd)}`
        : `  ${formatUsd(plan.totalSpendUsd)}`,
      `Cycle resets: ${reset ? reset.toLocaleString() : "unknown"}`,
      `Snapshot: ${result.source}${result.stale ? " (stale)" : ""}, age ${formatAge(result.ageMs)}`,
    ];
    if (result.refreshError) {
      periodLines.push(`  refresh error: ${result.refreshError}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    periodLines = [`Period usage: unavailable (${detail})`];
  }

  const overrideRaw = getState(openDb(home), "override_until");
  const overrideUntil = overrideRaw ? new Date(overrideRaw) : null;
  const overrideActive = overrideUntil && overrideUntil.getTime() > now.getTime();
  const maxEvents = config.rateLimit.maxEventsPerHour;

  return [
    ...(warning ? [warning, ""] : []),
    "cursor-budget",
    "",
    ...periodLines,
    "",
    hourWindow.label,
    maxEvents != null
      ? `  Events: ${eventsLastHour} / ${maxEvents}`
      : `  Events: ${eventsLastHour} (rate limit off)`,
    "",
    `On unknown usage: ${config.enforcement.failClosed ? "block (failClosed)" : "allow (failClosed off)"}`,
    `Override: ${overrideActive ? `until ${overrideUntil?.toLocaleString()}` : "none"}`,
    `Exceptions: ${
      config.excludeConversationIds.length === 0
        ? "none"
        : config.excludeConversationIds.join(", ")
    }`,
    `Config: ${configPath(home)}`,
  ].join("\n");
}
