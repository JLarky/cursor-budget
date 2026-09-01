import { getCursorPeriodUsage, getProvider, readAuthExpiry } from "../accounting/index.js";
import { formatAge, formatUsd, formatWindowLine } from "../budget/evaluator.js";
import { rollingHour } from "../budget/windows.js";
import { loadConfigForRead } from "../config.js";
import { buildCursorMeasurements } from "../cursor-measurements.js";
import { getCursorOverride, openDb } from "../db/client.js";
import { configPath } from "../paths.js";

function formatAuthExpiry(expiry: Date | null, now: Date): string {
  if (!expiry) return "expiry unknown";
  const days = (expiry.getTime() - now.getTime()) / 86_400_000;
  if (days <= 0) return `EXPIRED ${expiry.toLocaleDateString()} — run cursor-agent to re-authenticate`;
  return `expires in ${Math.floor(days)}d (${expiry.toLocaleDateString()})`;
}

export async function statusCommand(home?: string): Promise<string> {
  const { config, warning } = loadConfigForRead(home);
  const now = new Date();

  if (!config.cursor.enabled) {
    return [
      ...(warning ? [warning, ""] : []),
      "llm-budget",
      "",
      "Cursor Agent is disabled in config.",
      `Config: ${configPath(home)}`,
    ].join("\n");
  }

  const provider = getProvider(config, home);
  const hourWindow = rollingHour(now);
  const eventsLastHour = await provider.countEvents(hourWindow);

  let usageLines: string[] = ["Usage: unavailable"];
  try {
    const result = await getCursorPeriodUsage({
      home,
      cacheTtlMs: config.cursor.cacheTtlMs,
      now,
    });
    const plan = result.usage.planUsage;
    const reset = result.usage.billingCycleEnd;
    const measurements = buildCursorMeasurements(config, plan);
    usageLines = [
      ...measurements.map((m) => formatWindowLine(m)),
      "Period spend:",
      plan.limitUsd != null
        ? `  ${formatUsd(plan.totalSpendUsd)} / ${formatUsd(plan.limitUsd)}`
        : `  ${formatUsd(plan.totalSpendUsd)}`,
      `Cycle resets: ${reset ? reset.toLocaleString() : "unknown"}`,
      `Snapshot: ${result.source}${result.stale ? " (stale)" : ""}, age ${formatAge(result.ageMs)}`,
    ];
    if (result.refreshError) {
      usageLines.push(`  refresh error: ${result.refreshError}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    usageLines = [`Usage: unavailable (${detail})`];
  }

  const overrideRaw = getCursorOverride(openDb(home));
  const overrideUntil = overrideRaw ? new Date(overrideRaw) : null;
  const overrideActive = overrideUntil && overrideUntil.getTime() > now.getTime();
  const maxEvents = config.cursor.rateLimit.maxEventsPerHour;

  return [
    ...(warning ? [warning, ""] : []),
    "llm-budget",
    `Config: ${configPath(home)}`,
    `On unknown usage: ${config.enforcement.failClosed ? "block (failClosed)" : "allow (failClosed off)"}`,
    "",
    ...usageLines,
    "",
    hourWindow.label,
    maxEvents != null
      ? `  Events: ${eventsLastHour} / ${maxEvents}`
      : `  Events: ${eventsLastHour} (rate limit off)`,
    "",
    `Credential: ${formatAuthExpiry(readAuthExpiry(home), now)}`,
    `Override: ${overrideActive ? `until ${overrideUntil?.toLocaleString()}` : "none"}`,
    `Exceptions: ${
      config.cursor.excludeConversationIds.length === 0
        ? "none"
        : config.cursor.excludeConversationIds.join(", ")
    }`,
  ].join("\n");
}
