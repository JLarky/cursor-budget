import type { LlmConfig } from "./config.js";
import { openLlmDb, getState } from "./db.js";
import {
  formatBudgetBlockMessage,
  evaluateBudget,
  formatPercent,
  type BudgetEvaluation,
} from "./budget/evaluator.js";
import type { WindowMeasurement } from "./budget/evaluator.js";
import {
  fetchDirectUsage,
  providerUsage,
  type ProviderUsage,
  type UsageFetcher,
  type UsageSnapshot,
} from "./usage/index.js";

export type GuardAgent = "claude" | "codex";

export interface GuardDeps {
  /** Kept for config/db path resolution in embedded callers (hooks). */
  home?: string;
  now?: Date;
  /** Session id from the hook event (for exception matching). */
  sessionId?: string;
  /** Injectable usage source (tests); defaults to the vendor usage APIs. */
  fetchUsage?: UsageFetcher;
}

const ZERO_SNAPSHOT: UsageSnapshot = { fetchedAt: "", providers: [] };

export interface GuardDecision {
  allow: boolean;
  evaluation: BudgetEvaluation;
  config: LlmConfig;
  snapshot: UsageSnapshot;
  sessionId: string;
}

/**
 * One guard pass for one agent: read percentages from the vendor usage
 * APIs, then evaluate the configured gates.
 *
 * Never throws for expected failure paths — an unreachable API or an
 * unavailable provider becomes a `usageUnknown` decision so fail-closed
 * callers can still block with a reason.
 */
export async function runGuard(
  agent: GuardAgent,
  config: LlmConfig,
  deps: GuardDeps = {},
): Promise<GuardDecision> {
  // Disabled agents short-circuit before any network work: opting out of a
  // tool's guard must not be able to block it either.
  const enabled = agent === "claude" ? config.claudeCode.enabled : config.codex.enabled;
  if (!enabled) {
    return {
      allow: true,
      evaluation: { allow: true, reasons: [], overrideActive: false, excluded: false },
      config,
      snapshot: ZERO_SNAPSHOT,
      sessionId: deps.sessionId ?? "",
    };
  }

  const now = deps.now ?? new Date();
  const db = openLlmDb(deps.home);

  const excluded = Boolean(deps.sessionId && config.excludeSessionIds.includes(deps.sessionId));
  const overrideRaw = getState(db, "override_until");
  const overrideUntil = overrideRaw ? new Date(overrideRaw) : null;

  let snapshot: UsageSnapshot;
  let usageUnknownReason: string | null = null;
  try {
    snapshot = deps.fetchUsage
      ? await deps.fetchUsage()
      : await fetchDirectUsage({ home: deps.home });
  } catch (error) {
    snapshot = ZERO_SNAPSHOT;
    const detail = error instanceof Error ? error.message : String(error);
    usageUnknownReason = `Could not fetch ${agent} usage (${detail})`;
  }

  const provider = usageUnknownReason ? null : providerUsage(snapshot, agent);
  if (!usageUnknownReason && !provider) {
    usageUnknownReason = `No ${agent} usage entry — is ${agent} signed in?`;
  } else if (!usageUnknownReason && provider && provider.windows.length === 0) {
    const detail = provider.error ? ` — ${provider.error}` : "";
    usageUnknownReason = `${agent} usage ${provider.status}${detail}`;
  }

  const measurements =
    provider && !usageUnknownReason ? buildMeasurements(agent, config, provider) : [];
  if (!usageUnknownReason) {
    usageUnknownReason = missingGates(agent, measurements);
  }

  const evaluation = evaluateBudget({
    measurements,
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
    snapshot,
    sessionId: deps.sessionId ?? "",
  };
}

function effectiveCodexBlockAt(config: LlmConfig): number {
  return config.codex.openAiWeeklyBlockAtPercent ?? config.codex.weeklyBlockAtPercent;
}

function buildMeasurements(
  agent: GuardAgent,
  config: LlmConfig,
  provider: ProviderUsage,
): WindowMeasurement[] {
  const window = (id: string): (typeof provider.windows)[number] | null =>
    provider.windows.find((w) => w.id === id) ?? null;

  if (agent === "claude") {
    const measurements: WindowMeasurement[] = [];
    const weekly = window("weekly");
    if (weekly) {
      measurements.push({
        windowId: "claudeWeekly",
        label: "Weekly",
        usedPct: weekly.usedPct ?? Number.NaN,
        blockAtPct: config.claudeCode.weeklyBlockAtPercent,
        usedDisplay: pctDisplay(weekly.usedPct),
        denomDisplay: "Claude weekly limit",
        resetsAt: weekly.resetsAt,
      });
    }
    const rolling = window("five_hour");
    if (rolling) {
      measurements.push({
        windowId: "claudeRolling",
        label: "Rolling 5h",
        usedPct: rolling.usedPct ?? Number.NaN,
        blockAtPct: config.claudeCode.rolling5hBlockAtPercent,
        usedDisplay: pctDisplay(rolling.usedPct),
        denomDisplay: "Claude 5h limit",
        resetsAt: rolling.resetsAt,
      });
    }
    return measurements;
  }

  const session = window("session");
  if (!session) return [];
  return [
    {
      windowId: "codexWeekly",
      label: "Weekly (OpenAI)",
      usedPct: session.usedPct ?? Number.NaN,
      blockAtPct: effectiveCodexBlockAt(config),
      usedDisplay: pctDisplay(session.usedPct),
      denomDisplay: "OpenAI weekly limit",
      resetsAt: session.resetsAt,
    },
  ];
}

/** Every configured gate must have a measurement, else usage is unknown. */
function missingGates(agent: GuardAgent, measurements: WindowMeasurement[]): string | null {
  const present = new Set(measurements.map((m) => m.windowId));
  const needed: WindowMeasurement["windowId"][] =
    agent === "claude" ? ["claudeWeekly", "claudeRolling"] : ["codexWeekly"];
  const missing = needed.filter((id) => !present.has(id));
  if (missing.length === 0) return null;
  return `Usage API did not report the ${missing.join(", ")} window(s) for ${agent}`;
}

function pctDisplay(usedPct: number | null): string {
  return usedPct === null ? "unknown" : formatPercent(usedPct);
}

/** Render the user-facing deny message (session id + escape hatches). */
export function formatGuardDeny(
  decision: Pick<GuardDecision, "evaluation">,
  agent: GuardAgent,
  sessionId?: string,
): string {
  return formatBudgetBlockMessage(decision.evaluation, agent, sessionId);
}
