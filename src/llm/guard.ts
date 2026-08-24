import {
  windowUsage,
  denominatorAmount,
  usageDisplay,
  usedPctOf,
} from "./accounting.js";
import type { LlmConfig } from "./config.js";
import { getState, openLlmDb } from "./db.js";
import {
  formatBudgetBlockMessage,
  evaluateBudget,
  type BudgetEvaluation,
} from "./budget/evaluator.js";
import { loadRates } from "./pricing.js";
import type { WindowMeasurement } from "./budget/evaluator.js";
import {
  collectAgentUsage,
  type AgentKind,
  type ScanStats,
} from "./transcripts/scanner.js";
import {
  nextUtcWeekStart,
  rollingWindowStart,
  utcWeekStart,
} from "./budget/windows.js";

export type GuardAgent = "claude" | "codex";

export interface GuardDeps {
  home?: string;
  now?: Date;
  /** Injectable scan (tests); defaults to the real transcript collector. */
  scan?: (agent: AgentKind) => ScanStats;
  /** Session id from the hook event (for exception matching). */
  sessionId?: string;
}

const ZERO_STATS: ScanStats = {
  totalFiles: 0,
  scannedFiles: 0,
  skippedFiles: 0,
  failedFiles: 0,
  malformedLines: 0,
  addedEvents: 0,
  updatedEvents: 0,
};

export interface GuardDecision {
  allow: boolean;
  evaluation: BudgetEvaluation;
  config: LlmConfig;
  stats: ScanStats;
  sessionId: string;
}

/**
 * One guard pass for one agent: refresh local usage from transcripts, then
 * evaluate every configured gate.
 *
 * Never throws for expected failure paths — an unreadable transcript store or
 * a failed scan becomes a `usageUnknown` decision so fail-closed callers can
 * still block with a reason.
 */
export function runGuard(
  agent: GuardAgent,
  config: LlmConfig,
  deps: GuardDeps = {},
): GuardDecision {
  // Disabled agents short-circuit before any storage, transcript, or pricing
  // work: opting out of a tool's guard must not be able to block it either.
  const enabled = agent === "claude" ? config.claudeCode.enabled : config.codex.enabled;
  if (!enabled) {
    return {
      allow: true,
      evaluation: { allow: true, reasons: [], overrideActive: false, excluded: false },
      config,
      stats: { ...ZERO_STATS },
      sessionId: deps.sessionId ?? "",
    };
  }

  const db = openLlmDb(deps.home);
  const rates = loadRates(config.budget.rates, deps.home);

  let stats: ScanStats;
  let scanFailed = false;
  try {
    stats = deps.scan ? deps.scan(agent) : collectAgentUsage(agent, { home: deps.home });
  } catch {
    // Local db broken etc. Decide below via failClosed rather than crashing
    // into a fail-open wrapper.
    stats = { ...ZERO_STATS };
    scanFailed = true;
  }

  // Capture time AFTER scanning so events appended while we scanned (or
  // timestamped by file mtime during the scan) are inside the windows.
  const now = deps.now ?? new Date();

  const excluded = Boolean(deps.sessionId && config.excludeSessionIds.includes(deps.sessionId));

  const overrideRaw = getState(db, "override_until");
  const overrideUntil = overrideRaw ? new Date(overrideRaw) : null;

  let usageUnknownReason: string | null = null;
  if (scanFailed) {
    usageUnknownReason =
      "local transcript database could not be read or updated (run llm-budget status)";
  } else if (stats.unreadableRoots && stats.unreadableRoots.length > 0) {
    usageUnknownReason = `transcript directories unreadable: ${stats.unreadableRoots.join("; ")}`;
  } else if ((stats.failedFiles ?? 0) > 0) {
    // Any unreadable file may hold threshold-crossing usage we cannot see.
    const names = (stats.failedFileNames ?? []).map((f) => f.split("/").pop()).join(", ");
    usageUnknownReason =
      `${stats.failedFiles} transcript file(s) unreadable` +
      (names ? ` (${names})` : "") +
      " — their usage cannot be counted";
  }
  // Always pass the resolved table even when empty: with a USD denominator an
  // empty table must flag every model as unpriced (missing money), not skip
  // pricing entirely.
  const built = buildMeasurements(agent, config, db, rates, now);

  // A USD denominator with unpriced models means measured spend is missing
  // money, not zero money — same fail-closed treatment as unknown usage.
  if (
    usageUnknownReason === null &&
    config.budget.denominator.kind === "usd" &&
    built.unpricedModels.length > 0
  ) {
    usageUnknownReason =
      `models without rates cost $0 in the math: ${built.unpricedModels.slice(0, 5).join(", ")}` +
      " — run llm-budget import-rates";
  }

  const evaluation = evaluateBudget({
    measurements: built.measurements,
    overrideUntil,
    now,
    excluded,
    failClosed: config.enforcement.failClosed,
    usageUnknownReason,
  });

  return {
    allow: evaluation.allow,
    evaluation,
    config,
    stats,
    sessionId: deps.sessionId ?? "",
  };
}

function buildMeasurements(
  agent: GuardAgent,
  config: LlmConfig,
  db: ReturnType<typeof openLlmDb>,
  rates: Parameters<typeof windowUsage>[4],
  now: Date,
): { measurements: WindowMeasurement[]; unpricedModels: string[] } {
  const denom = config.budget.denominator;
  const denomLabel = denominatorAmount(denom);
  const weekFrom = utcWeekStart(now);

  if (agent === "claude") {
    // Rolling windows are half-open (from, to]: an event exactly at
    // now-windowMs has aged out.
    const rollFrom = rollingWindowStart(now, config.claudeCode.rollingWindowMs);
    const weeklyUsage = windowUsage(db, agent, weekFrom, now, rates, config.excludeSessionIds);
    const rollingUsage = windowUsage(db, agent, rollFrom, now, rates, config.excludeSessionIds, {
      fromInclusive: false,
    });
    return {
      measurements: [
        {
          windowId: "claudeWeekly",
          label: "Weekly",
          usedPct: usedPctOf(denom, weeklyUsage),
          blockAtPct: config.claudeCode.weeklyBlockAtPercent,
          usedDisplay: usageDisplay(weeklyUsage, denom.kind),
          denomDisplay: denomLabel,
        },
        {
          windowId: "claudeRolling",
          label: `Rolling ${formatHours(config.claudeCode.rollingWindowMs)}`,
          usedPct: usedPctOf(denom, rollingUsage),
          blockAtPct: config.claudeCode.rolling5hBlockAtPercent,
          usedDisplay: usageDisplay(rollingUsage, denom.kind),
          denomDisplay: denomLabel,
        },
      ],
      unpricedModels: [...new Set([...weeklyUsage.unpricedModels, ...rollingUsage.unpricedModels])],
    };
  }

  const weeklyUsage = windowUsage(db, agent, weekFrom, now, rates, config.excludeSessionIds);
  return {
    measurements: [
      {
        windowId: "codexWeekly",
        label: "Weekly",
        usedPct: usedPctOf(denom, weeklyUsage),
        blockAtPct: config.codex.weeklyBlockAtPercent,
        usedDisplay: usageDisplay(weeklyUsage, denom.kind),
        denomDisplay: denomLabel,
      },
    ],
    unpricedModels: weeklyUsage.unpricedModels,
  };
}

function formatHours(ms: number): string {
  return `${Math.round((ms / 3_600_000) * 10) / 10}h`;
}

/** Render the user-facing deny message (session id + escape hatches). */
export function formatGuardDeny(
  decision: Pick<GuardDecision, "evaluation">,
  agent: GuardAgent,
  sessionId?: string,
): string {
  return formatBudgetBlockMessage(decision.evaluation, agent, sessionId);
}

export function weeklyResetIso(now: Date): string {
  return nextUtcWeekStart(now).toISOString();
}
