import type { BudgetWindowId } from "./windows.js";
import { nextUtcWeekStart, utcWeekStart } from "./windows.js";

export interface WindowMeasurement {
  windowId: BudgetWindowId;
  label: string;
  /** 0–100 percent of the configured denominator actually used. */
  usedPct: number;
  /** Block threshold in the same scale. */
  blockAtPct: number;
  usedDisplay: string;
  denomDisplay: string;
}

export interface BudgetBlockReason {
  windowId: BudgetWindowId;
  windowLabel: string;
  usedPct?: number;
  blockAtPct?: number;
  usedDisplay?: string;
  denomDisplay?: string;
  /** Why usage could not be determined (only for `usageUnknown`). */
  detail?: string;
}

export interface BudgetEvaluation {
  allow: boolean;
  reasons: BudgetBlockReason[];
  overrideActive: boolean;
  excluded: boolean;
}

/**
 * Decide whether to allow agent work, mirroring cursor-budget's evaluator:
 * escape hatches first, then every gate contributes block reasons.
 */
export function evaluateBudget(input: {
  measurements: WindowMeasurement[];
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
    if (Number.isFinite(m.usedPct) && m.usedPct >= m.blockAtPct) {
      reasons.push({
        windowId: m.windowId,
        windowLabel: m.label,
        usedPct: m.usedPct,
        blockAtPct: m.blockAtPct,
        usedDisplay: m.usedDisplay,
        denomDisplay: m.denomDisplay,
      });
    }
  }

  if (
    reasons.length === 0 &&
    input.usageUnknownReason &&
    (input.failClosed ?? true)
  ) {
    reasons.push({
      windowId: "usageUnknown",
      windowLabel: "Transcript usage",
      detail: input.usageUnknownReason,
    });
  }

  return { allow: reasons.length === 0, reasons, overrideActive: false, excluded: false };
}

const TOOL_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export function formatBudgetBlockMessage(
  evaluation: BudgetEvaluation,
  agent: "claude" | "codex",
  sessionId?: string,
): string {
  const id = sessionId?.trim() || "unknown";
  const tool = TOOL_LABELS[agent] ?? agent;
  const lines = [`${tool} blocked by llm-budget.`, "", `Session id: ${id}`, ""];

  const primary = evaluation.reasons[0];
  if (primary) {
    if (primary.windowId === "usageUnknown") {
      lines.push("Usage could not be determined:");
      lines.push(`  ${primary.detail ?? "unknown"}`);
      lines.push("");
      lines.push("Blocked because enforcement.failClosed is on (the default).");
    } else {
      lines.push(`${primary.windowLabel} budget reached:`);
      lines.push(
        `  ${formatPercent(primary.usedPct ?? Number.NaN)} of ${formatPercent(primary.blockAtPct ?? Number.NaN)} block threshold`,
        `  ${primary.usedDisplay} / ${primary.denomDisplay}`,
      );
    }
    lines.push("");
  }

  if (agent === "codex") {
    const weekStart = utcWeekStart(new Date());
    lines.push(
      `Weekly window: pinned UTC week starting ${weekStart.toISOString()} — resets ${nextUtcWeekStart(new Date()).toISOString()}`,
    );
    lines.push("");
  }

  lines.push("Run:");
  lines.push("  llm-budget status");
  lines.push("  llm-budget override 30m");
  lines.push(`  llm-budget except add ${id}`);
  return lines.join("\n");
}

export function formatPercent(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Number.isInteger(n)) return `${n}%`;
  return `${n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}
