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
  const now = deps.now ?? new Date();

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

  const excluded = Boolean(deps.sessionId && config.excludeSessionIds.includes(deps.sessionId));

  const overrideRaw = getState(db, "override_until");
  const overrideUntil = overrideRaw ? new Date(overrideRaw) : null;

  let usageUnknownReason: string | null = null;
  if (scanFailed) {
    usageUnknownReason =
      "local transcript database could not be read or updated (run llm-budget status)";
  } else if (stats.unreadableRoots && stats.unreadableRoots.length > 0) {
    usageUnknownReason = `transcript directories unreadable: ${stats.unreadableRoots.join("; ")}`;
  } else if (
    stats.totalFiles > 0 &&
    stats.scannedFiles === 0 &&
    stats.skippedFiles === 0
  ) {
    usageUnknownReason = `all ${stats.totalFiles} transcript files failed to read`;
  }
  const windowMeasurements = buildMeasurements(
    agent,
    config,
    db,
    rates.rates.size > 0 ? rates : null,
    now,
  );

  const evaluation = evaluateBudget({
    measurements: windowMeasurements,
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
) {
  const denom = config.budget.denominator;
  const denomLabel = denominatorAmount(denom);
  const weekFrom = utcWeekStart(now);
  const weeklyUsage = windowUsage(db, agent, weekFrom, now, rates, config.excludeSessionIds);

  if (agent === "claude") {
    const rollFrom = rollingWindowStart(now, config.claudeCode.rollingWindowMs);
    const rollingUsage = windowUsage(db, agent, rollFrom, now, rates, config.excludeSessionIds);
    return [
      {
        windowId: "claudeWeekly" as const,
        label: "Weekly",
        usedPct: usedPctOf(denom, weeklyUsage),
        blockAtPct: config.claudeCode.weeklyBlockAtPercent,
        usedDisplay: usageDisplay(weeklyUsage, denom.kind),
        denomDisplay: denomLabel,
      },
      {
        windowId: "claudeRolling" as const,
        label: `Rolling ${formatHours(config.claudeCode.rollingWindowMs)}`,
        usedPct: usedPctOf(denom, rollingUsage),
        blockAtPct: config.claudeCode.rolling5hBlockAtPercent,
        usedDisplay: usageDisplay(rollingUsage, denom.kind),
        denomDisplay: denomLabel,
      },
    ];
  }

  return [
    {
      windowId: "codexWeekly" as const,
      label: "Weekly",
      usedPct: usedPctOf(denom, weeklyUsage),
      blockAtPct: config.codex.weeklyBlockAtPercent,
      usedDisplay: usageDisplay(weeklyUsage, denom.kind),
      denomDisplay: denomLabel,
    },
  ];
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
