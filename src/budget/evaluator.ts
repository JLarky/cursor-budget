import type { Config, Limit } from "../config.js";
import type { Usage } from "../accounting/types.js";
import type { WindowId } from "./windows.js";

export interface BlockReason {
  window: WindowId;
  windowLabel: string;
  metric: "usd" | "tokens";
  used: number;
  limit: number;
}

export interface Evaluation {
  allow: boolean;
  reasons: BlockReason[];
  overrideActive: boolean;
  excluded: boolean;
  unknownModelBlocked: boolean;
}

export function evaluate(input: {
  hour: Usage;
  day: Usage;
  config: Config;
  overrideUntil: Date | null;
  now?: Date;
  excluded?: boolean;
  unknownModel?: boolean;
}): Evaluation {
  const now = input.now ?? new Date();
  if (input.excluded) {
    return {
      allow: true,
      reasons: [],
      overrideActive: false,
      excluded: true,
      unknownModelBlocked: false,
    };
  }

  const overrideActive = Boolean(input.overrideUntil && input.overrideUntil.getTime() > now.getTime());
  if (overrideActive) {
    return {
      allow: true,
      reasons: [],
      overrideActive: true,
      excluded: false,
      unknownModelBlocked: false,
    };
  }

  if (input.unknownModel && input.config.unknownModel === "block") {
    return {
      allow: false,
      reasons: [],
      overrideActive: false,
      excluded: false,
      unknownModelBlocked: true,
    };
  }

  const reasons: BlockReason[] = [
    ...limitReasons("rollingHour", "Last 60 minutes", input.hour, input.config.limits.rollingHour),
    ...limitReasons("calendarDay", "Today", input.day, input.config.limits.calendarDay),
  ];

  return {
    allow: reasons.length === 0,
    reasons,
    overrideActive: false,
    excluded: false,
    unknownModelBlocked: false,
  };
}

function limitReasons(
  window: WindowId,
  windowLabel: string,
  usage: Usage,
  limit: Limit,
): BlockReason[] {
  const reasons: BlockReason[] = [];
  if (limit.usd != null && usage.usd != null && usage.usd >= limit.usd) {
    reasons.push({
      window,
      windowLabel,
      metric: "usd",
      used: usage.usd,
      limit: limit.usd,
    });
  }
  if (limit.tokens != null && usage.totalTokens >= limit.tokens) {
    reasons.push({
      window,
      windowLabel,
      metric: "tokens",
      used: usage.totalTokens,
      limit: limit.tokens,
    });
  }
  return reasons;
}

export function formatBlockMessage(
  evaluation: Evaluation,
  hour: Usage,
  day: Usage,
  config: Config,
  sessionId?: string,
): string {
  const id = sessionId?.trim() || "unknown";
  if (evaluation.unknownModelBlocked) {
    return [
      "Cursor Agent blocked by cursor-budget.",
      "",
      `Session id: ${id}`,
      "",
      "Unknown model and unknownModel is set to block.",
      "Accounting is estimated from locally observable Cursor activity.",
      "",
      "Run:",
      "  cursor-budget status",
      "  cursor-budget override 30m",
      `  cursor-budget except add ${id}`,
    ].join("\n");
  }

  const primary = evaluation.reasons[0];
  const lines = ["Cursor Agent blocked by cursor-budget.", "", `Session id: ${id}`, ""];
  if (primary) {
    const kind = primary.window === "rollingHour" ? "Rolling 60m" : "Daily";
    if (primary.metric === "tokens") {
      lines.push(`${kind} token limit reached:`);
      lines.push(`  ${formatTokens(primary.used)} / ${formatTokens(primary.limit)} estimated tokens`);
    } else {
      lines.push(`${kind} dollar limit reached:`);
      lines.push(`  ${formatUsd(primary.used)} / ${formatUsd(primary.limit)}`);
    }
    lines.push("");
  }

  const dayUsd = config.limits.calendarDay.usd;
  const hourUsd = config.limits.rollingHour.usd;
  lines.push("Daily usage:");
  lines.push(`  ${formatUsd(day.usd ?? 0)}${dayUsd != null ? ` / ${formatUsd(dayUsd)}` : ""}`);
  if (hour.usd != null) {
    lines.push("Hourly usage:");
    lines.push(`  ${formatUsd(hour.usd)}${hourUsd != null ? ` / ${formatUsd(hourUsd)}` : ""}`);
  }
  lines.push("");
  lines.push("Accounting is estimated from locally observable Cursor activity.");
  lines.push("");
  lines.push("Run:");
  lines.push("  cursor-budget status");
  lines.push("  cursor-budget override 30m");
  lines.push(`  cursor-budget except add ${id}`);
  return lines.join("\n");
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(Math.round(value));
}

export function formatPercent(used: number, limit: number | null): string {
  if (limit == null || limit <= 0) return "—";
  return `${Math.round((used / limit) * 100)}%`;
}
