import type { WindowId } from "./windows.js";

/**
 * One agent's window shape, ready to evaluate: `blockAtPercent === null`
 * means monitor-only (measured and displayed, never enforced).
 */
export interface WindowMeasurement {
  windowId: WindowId;
  label: string;
  /** 0–100 percent of the provider's own limit actually used. NaN if unreported. */
  usedPct: number;
  blockAtPercent: number | null;
  usedDisplay: string;
  denomDisplay: string;
  resetsAt?: string | null;
}

/** Local rolling-hour event count backstop (Cursor Agent only). */
export interface EventRateMeasurement {
  used: number;
  /** null disables the backstop. */
  limit: number | null;
}

export type BudgetBlockReason =
  | {
      kind: "window";
      windowId: WindowId;
      windowLabel: string;
      usedPct: number;
      blockAtPercent: number;
      usedDisplay: string;
      denomDisplay: string;
      resetsAt: string | null;
    }
  | { kind: "eventRate"; used: number; limit: number }
  | { kind: "usageUnknown"; detail: string };

export interface BudgetEvaluation {
  allow: boolean;
  reasons: BudgetBlockReason[];
  /** Every measurement taken, enforced or not — for block-message context and status. */
  displayMeasurements?: WindowMeasurement[];
  overrideActive: boolean;
  excluded: boolean;
}

/**
 * Decide whether to allow agent work: escape hatches first, then every
 * enforced window and the event-rate backstop contribute block reasons.
 * Monitor-only windows (`blockAtPercent: null`) are never enforced.
 */
export function evaluateBudget(input: {
  measurements: WindowMeasurement[];
  eventRate?: EventRateMeasurement;
  overrideUntil: Date | null;
  now: Date;
  excluded?: boolean;
  failClosed?: boolean;
  usageUnknownReason?: string | null;
}): BudgetEvaluation {
  if (input.excluded) {
    return { allow: true, reasons: [], overrideActive: false, excluded: true };
  }

  const overrideActive = Boolean(
    input.overrideUntil && input.overrideUntil.getTime() > input.now.getTime(),
  );
  if (overrideActive) {
    return { allow: true, reasons: [], overrideActive: true, excluded: false };
  }

  const reasons: BudgetBlockReason[] = [];
  const unavailableEnforced: string[] = [];
  for (const m of input.measurements) {
    if (m.blockAtPercent === null) continue;
    // Numeric threshold with no usable meter: cannot evaluate — failClosed
    // treats this as unknown usage rather than an unarmed pass.
    if (!Number.isFinite(m.usedPct)) {
      unavailableEnforced.push(m.label);
      continue;
    }
    if (m.usedPct >= m.blockAtPercent) {
      reasons.push({
        kind: "window",
        windowId: m.windowId,
        windowLabel: m.label,
        usedPct: m.usedPct,
        blockAtPercent: m.blockAtPercent,
        usedDisplay: m.usedDisplay,
        denomDisplay: m.denomDisplay,
        resetsAt: m.resetsAt ?? null,
      });
    }
  }

  if (input.eventRate && input.eventRate.limit != null && input.eventRate.used >= input.eventRate.limit) {
    reasons.push({ kind: "eventRate", used: input.eventRate.used, limit: input.eventRate.limit });
  }

  if (reasons.length === 0 && (input.failClosed ?? true)) {
    const detail =
      input.usageUnknownReason ??
      (unavailableEnforced.length > 0
        ? `Usage unavailable for enforced window(s): ${unavailableEnforced.join(", ")}`
        : null);
    if (detail) {
      reasons.push({ kind: "usageUnknown", detail });
    }
  }

  return { allow: reasons.length === 0, reasons, overrideActive: false, excluded: false };
}

export function formatPercent(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Number.isInteger(n)) return `${n}%`;
  return `${n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

export function formatNullablePercent(value: number | null): string {
  if (value == null) return "unavailable";
  return formatPercent(value);
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

export type ResetRemaining =
  | { kind: "invalid" }
  | { kind: "past" }
  | { kind: "under_minute" }
  | { kind: "hours_minutes"; hours: number; minutes: number }
  | { kind: "days_hours"; days: number; hours: number };

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function parseResetRemaining(resetsAt: string, now: Date): ResetRemaining {
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) return { kind: "invalid" };
  const remainingMs = resetMs - now.getTime();
  if (remainingMs <= 0) return { kind: "past" };
  if (remainingMs < MINUTE_MS) return { kind: "under_minute" };
  if (remainingMs < DAY_MS) {
    return {
      kind: "hours_minutes",
      hours: Math.floor(remainingMs / HOUR_MS),
      minutes: Math.floor((remainingMs % HOUR_MS) / MINUTE_MS),
    };
  }
  return {
    kind: "days_hours",
    days: Math.floor(remainingMs / DAY_MS),
    hours: Math.floor((remainingMs % DAY_MS) / HOUR_MS),
  };
}

function counted(n: number, singular: string): string {
  return `${n} ${n === 1 ? singular : `${singular}s`}`;
}

function inPhrase(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return ` (in ${parts[0]})`;
  return ` (in ${parts[0]} and ${parts[1]})`;
}

export function formatResetRemaining(remaining: ResetRemaining): string {
  switch (remaining.kind) {
    case "invalid":
      return "";
    case "past":
      return " (already reset)";
    case "under_minute":
      return " (in less than a minute)";
    case "hours_minutes": {
      const parts: string[] = [];
      if (remaining.hours > 0) parts.push(counted(remaining.hours, "hour"));
      if (remaining.minutes > 0) parts.push(counted(remaining.minutes, "minute"));
      return inPhrase(parts);
    }
    case "days_hours": {
      const parts: string[] = [];
      if (remaining.days > 0) parts.push(counted(remaining.days, "day"));
      if (remaining.hours > 0) parts.push(counted(remaining.hours, "hour"));
      return inPhrase(parts);
    }
    default: {
      const _exhaustive: never = remaining;
      return _exhaustive;
    }
  }
}

export function formatResetCountdown(resetsAt: string, now: Date): string {
  return formatResetRemaining(parseResetRemaining(resetsAt, now));
}

function windowLineStatus(m: WindowMeasurement): string {
  if (m.blockAtPercent === null) return "monitor-only";
  if (!Number.isFinite(m.usedPct)) return "usage unknown";
  return `block at ${formatPercent(m.blockAtPercent)}`;
}

export function formatWindowLine(m: WindowMeasurement, now: Date = new Date()): string {
  const reset = m.resetsAt ? ` — resets ${m.resetsAt}${formatResetCountdown(m.resetsAt, now)}` : "";
  const status = windowLineStatus(m);
  if (!Number.isFinite(m.usedPct)) {
    return `${m.label}: unavailable (${status})${reset}`;
  }
  return `${m.label}: ${formatPercent(m.usedPct)} (${status})${reset}`;
}

export function formatAge(ageMs: number): string {
  const ms = Number(ageMs);
  if (!Number.isFinite(ms) || ms < 0) return "unknown age";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
