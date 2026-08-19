import { getProvider } from "../accounting/index.js";
import { formatPercent, formatTokens, formatUsd } from "../budget/evaluator.js";
import { calendarDay, rollingHour } from "../budget/windows.js";
import { loadConfigForRead } from "../config.js";
import { getState, openDb } from "../db/client.js";
import { configPath } from "../paths.js";

export async function statusCommand(): Promise<string> {
  const { config, warning } = loadConfigForRead();
  const provider = getProvider(config);
  const now = new Date();
  const hourWindow = rollingHour(now);
  const dayWindow = calendarDay(now);
  const [hour, day] = await Promise.all([
    provider.getUsage(hourWindow),
    provider.getUsage(dayWindow),
  ]);
  const overrideRaw = getState(openDb(), "override_until");
  const overrideUntil = overrideRaw ? new Date(overrideRaw) : null;
  const overrideActive = overrideUntil && overrideUntil.getTime() > now.getTime();

  const hourUsdLimit = config.limits.rollingHour.usd;
  const hourTokenLimit = config.limits.rollingHour.tokens;
  const dayUsdLimit = config.limits.calendarDay.usd;
  const dayTokenLimit = config.limits.calendarDay.tokens;

  return [
    ...(warning ? [warning, ""] : []),
    "Cursor LLM Budget",
    "",
    hourWindow.label,
    `  Estimated cost:   ${formatUsd(hour.usd ?? 0)}${hourUsdLimit != null ? ` / ${formatUsd(hourUsdLimit)}  (${formatPercent(hour.usd ?? 0, hourUsdLimit)})` : ""}`,
    `  Observable tokens: ${formatTokens(hour.observableTokens ?? 0)}`,
    `  Estimated tokens: ${formatTokens(hour.totalTokens)}${hourTokenLimit != null ? ` / ${formatTokens(hourTokenLimit)}   (${formatPercent(hour.totalTokens, hourTokenLimit)})` : ""}`,
    "",
    dayWindow.label,
    `  Estimated cost:   ${formatUsd(day.usd ?? 0)}${dayUsdLimit != null ? ` / ${formatUsd(dayUsdLimit)}  (${formatPercent(day.usd ?? 0, dayUsdLimit)})` : ""}`,
    `  Estimated tokens: ${formatTokens(day.totalTokens)}${dayTokenLimit != null ? ` / ${formatTokens(dayTokenLimit)}   (${formatPercent(day.totalTokens, dayTokenLimit)})` : ""}`,
    "",
    "Accounting: estimated",
    `Safety multiplier: ${config.accounting.safetyMultiplier.toFixed(1)}x`,
    `Override: ${overrideActive ? `until ${overrideUntil?.toLocaleString()}` : "none"}`,
    `Exceptions: ${
      config.excludeConversationIds.length === 0
        ? "none"
        : config.excludeConversationIds.join(", ")
    }`,
    `Config: ${configPath()}`,
    "",
    "Estimated usage is not Cursor billed spend.",
  ].join("\n");
}
