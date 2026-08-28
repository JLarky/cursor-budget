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
  for (const m of input.measurements) {
    if (m.blockAtPercent === null) continue;
    if (Number.isFinite(m.usedPct) && m.usedPct >= m.blockAtPercent) {
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

  if (reasons.length === 0 && input.usageUnknownReason && (input.failClosed ?? true)) {
    reasons.push({ kind: "usageUnknown", detail: input.usageUnknownReason });
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

/** One status line for a window: usage, enforced-or-monitor-only, and reset time. */
export function formatWindowLine(m: WindowMeasurement): string {
  const used = Number.isFinite(m.usedPct) ? formatPercent(m.usedPct) : m.usedDisplay;
  const status =
    m.blockAtPercent === null ? "monitor-only" : `block at ${formatPercent(m.blockAtPercent)}`;
  const reset = m.resetsAt ? ` — resets ${m.resetsAt}` : "";
  return `${m.label}: ${used} (${status})${reset}`;
}

export function formatAge(ageMs: number): string {
  const ms = Number(ageMs);
  if (!Number.isFinite(ms) || ms < 0) return "unknown age";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
