import type {
  CursorPeriodUsage,
  CursorPeriodUsageResult,
} from "../accounting/cursor-api.js";
import type { Config } from "../config.js";
import type { WindowId } from "./windows.js";

export type BlockMetric =
  | "cursorModelsPercent"
  | "otherModelsPercent"
  | "totalPercent"
  | "eventRate";

export interface BlockReason {
  window: WindowId;
  windowLabel: string;
  metric: BlockMetric;
  used: number;
  limit: number;
}

export interface Evaluation {
  allow: boolean;
  reasons: BlockReason[];
  overrideActive: boolean;
  excluded: boolean;
}

/**
 * Decide whether to allow agent work.
 *
 * Primary gate: Cursor dashboard percent meters (when `periodUsage` is usable).
 * Backstop: rolling-hour event count (always local).
 *
 * Callers must apply the §5 failure policy before passing `periodUsage`:
 * pass `null` when usage is unknown (too stale, unavailable, auth failure).
 * A `null` percent field inside a usable snapshot skips that meter (fail open),
 * never treating absent as 0.
 */
export function evaluate(input: {
  periodUsage: CursorPeriodUsageResult | null;
  eventsLastHour: number;
  config: Config;
  overrideUntil: Date | null;
  now?: Date;
  excluded?: boolean;
}): Evaluation {
  const now = input.now ?? new Date();
  if (input.excluded) {
    return {
      allow: true,
      reasons: [],
      overrideActive: false,
      excluded: true,
    };
  }

  const overrideActive = Boolean(
    input.overrideUntil && input.overrideUntil.getTime() > now.getTime(),
  );
  if (overrideActive) {
    return {
      allow: true,
      reasons: [],
      overrideActive: true,
      excluded: false,
    };
  }

  const reasons: BlockReason[] = [];

  if (input.periodUsage) {
    reasons.push(...quotaReasons(input.periodUsage.usage, input.config));
  }

  const maxEvents = input.config.rateLimit.maxEventsPerHour;
  if (maxEvents != null && input.eventsLastHour >= maxEvents) {
    reasons.push({
      window: "rollingHour",
      windowLabel: "Last 60 minutes",
      metric: "eventRate",
      used: input.eventsLastHour,
      limit: maxEvents,
    });
  }

  return {
    allow: reasons.length === 0,
    reasons,
    overrideActive: false,
    excluded: false,
  };
}

function quotaReasons(usage: CursorPeriodUsage, config: Config): BlockReason[] {
  const reasons: BlockReason[] = [];
  const plan = usage.planUsage;

  // Absent/renamed meters stay null — never treat as 0 (would make the gate unreachable).
  pushPercentReason(
    reasons,
    "cursorModels",
    "Cursor Models",
    "cursorModelsPercent",
    plan.autoPercentUsed,
    config.quota.cursorModelsBlockAtPercent,
  );
  pushPercentReason(
    reasons,
    "otherModels",
    "Other Models",
    "otherModelsPercent",
    plan.apiPercentUsed,
    config.quota.otherModelsBlockAtPercent,
  );
  if (config.quota.totalBlockAtPercent != null) {
    pushPercentReason(
      reasons,
      "totalQuota",
      "Total quota",
      "totalPercent",
      plan.totalPercentUsed,
      config.quota.totalBlockAtPercent,
    );
  }
  return reasons;
}

function pushPercentReason(
  reasons: BlockReason[],
  window: WindowId,
  windowLabel: string,
  metric: BlockMetric,
  used: number | null,
  limit: number,
): void {
  if (used == null) return;
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return;
  if (used >= limit) {
    reasons.push({ window, windowLabel, metric, used, limit });
  }
}

export function formatBlockMessage(
  evaluation: Evaluation,
  periodUsage: CursorPeriodUsageResult | null,
  eventsLastHour: number,
  config: Config,
  sessionId?: string,
): string {
  const id = sessionId?.trim() || "unknown";
  const primary = evaluation.reasons[0];
  const lines = ["Cursor Agent blocked by cursor-budget.", "", `Session id: ${id}`, ""];

  if (primary) {
    if (primary.metric === "eventRate") {
      lines.push("Rolling-hour event rate limit reached:");
      lines.push(`  ${primary.used} / ${primary.limit} events`);
    } else {
      lines.push(`${primary.windowLabel} quota limit reached:`);
      lines.push(`  ${formatPercentValue(primary.used)} / ${formatPercentValue(primary.limit)} used`);
    }
    lines.push("");
  }

  if (periodUsage) {
    const plan = periodUsage.usage.planUsage;
    lines.push("Cursor Models:");
    lines.push(`  ${formatNullablePercent(plan.autoPercentUsed)}`);
    lines.push("Other Models:");
    lines.push(`  ${formatNullablePercent(plan.apiPercentUsed)}`);
    if (plan.limitUsd != null) {
      lines.push("Period spend:");
      lines.push(`  ${formatUsd(plan.totalSpendUsd)} / ${formatUsd(plan.limitUsd)}`);
    } else {
      lines.push("Period spend:");
      lines.push(`  ${formatUsd(plan.totalSpendUsd)}`);
    }
    const reset = periodUsage.usage.billingCycleEnd;
    if (reset) {
      lines.push(`Cycle resets: ${reset.toLocaleString()}`);
    }
    if (periodUsage.stale || periodUsage.source === "stale-cache") {
      lines.push(`Snapshot: stale (${formatAge(periodUsage.ageMs)}, source ${periodUsage.source})`);
    } else {
      lines.push(`Snapshot: ${periodUsage.source} (age ${formatAge(periodUsage.ageMs)})`);
    }
    lines.push("");
  }

  const maxEvents = config.rateLimit.maxEventsPerHour;
  lines.push("Events (last 60m):");
  lines.push(
    maxEvents != null
      ? `  ${eventsLastHour} / ${maxEvents}`
      : `  ${eventsLastHour} (no rate limit)`,
  );
  lines.push("");
  lines.push("Run:");
  lines.push("  cursor-budget status");
  lines.push("  cursor-budget override 30m");
  lines.push(`  cursor-budget except add ${id}`);
  return lines.join("\n");
}

export function formatUsd(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "$?—";
  const abs = Math.abs(n);
  if (abs > 0 && abs < 0.01) {
    const trimmed = n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    return `$${trimmed}`;
  }
  return `$${n.toFixed(2)}`;
}

export function formatPercentValue(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Number.isInteger(n)) return `${n}%`;
  return `${n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

export function formatNullablePercent(value: number | null): string {
  if (value == null) return "unavailable";
  return formatPercentValue(value);
}

export function formatAge(ageMs: number): string {
  const ms = Number(ageMs);
  if (!Number.isFinite(ms) || ms < 0) return "unknown age";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
