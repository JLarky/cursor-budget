import type { Config } from "../config.js";
import { openLlmDb, getState } from "./db.js";
import {
  evaluateBudget,
  formatPercent,
  formatResetCountdown,
  type BudgetEvaluation,
  type WindowMeasurement,
} from "../budget/evaluator.js";
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
  config: Config;
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
  config: Config,
  deps: GuardDeps = {},
): Promise<GuardDecision> {
  // Disabled agents short-circuit before any network work: opting out of a
  // tool's guard must not be able to block it either.
  const enabled = agent === "claude" ? config.claude.enabled : config.codex.enabled;
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
    usageUnknownReason = missingGates(agent, config, measurements);
  }

  const evaluation = evaluateBudget({
    measurements,
    overrideUntil,
    now,
    excluded,
    failClosed: config.enforcement.failClosed,
    usageUnknownReason,
  });
  evaluation.displayMeasurements = measurements;

  return {
    allow: evaluation.allow,
    evaluation,
    config,
    snapshot,
    sessionId: deps.sessionId ?? "",
  };
}

/**
 * Build the window measurements for one agent from its vendor usage report.
 * Shared by `runGuard` and the `status` view so the numbers and thresholds
 * shown always match what the guard actually enforces.
 */
export function buildMeasurements(
  agent: GuardAgent,
  config: Config,
  provider: ProviderUsage,
): WindowMeasurement[] {
  const findWindow = (id: string): (typeof provider.windows)[number] | null =>
    provider.windows.find((w) => w.id === id) ?? null;

  if (agent === "claude") {
    const measurements: WindowMeasurement[] = [];
    const weekly = findWindow("weekly");
    if (weekly) {
      measurements.push({
        windowId: "weekly",
        label: "Weekly",
        usedPct: weekly.usedPct ?? Number.NaN,
        blockAtPercent: config.claude.windows.weekly.blockAtPercent,
        usedDisplay: pctDisplay(weekly.usedPct),
        denomDisplay: "Claude weekly limit",
        resetsAt: weekly.resetsAt,
      });
    }
    const rolling = findWindow("five_hour");
    if (rolling) {
      measurements.push({
        windowId: "five_hour",
        label: "Rolling 5h",
        usedPct: rolling.usedPct ?? Number.NaN,
        blockAtPercent: config.claude.windows.five_hour.blockAtPercent,
        usedDisplay: pctDisplay(rolling.usedPct),
        denomDisplay: "Claude 5h limit",
        resetsAt: rolling.resetsAt,
      });
    }
    return measurements;
  }

  const measurements: WindowMeasurement[] = [];
  const session = findWindow("session");
  if (session) {
    measurements.push({
      windowId: "session",
      label: "Session (OpenAI 5h)",
      usedPct: session.usedPct ?? Number.NaN,
      blockAtPercent: config.codex.windows.session.blockAtPercent,
      usedDisplay: pctDisplay(session.usedPct),
      denomDisplay: "OpenAI 5h limit",
      resetsAt: session.resetsAt,
    });
  }

  const weekly = findWindow("weekly");
  if (weekly) {
    measurements.push({
      windowId: "weekly",
      label: "Weekly (OpenAI)",
      usedPct: weekly.usedPct ?? Number.NaN,
      blockAtPercent: config.codex.windows.weekly.blockAtPercent,
      usedDisplay: pctDisplay(weekly.usedPct),
      denomDisplay: "OpenAI weekly limit",
      resetsAt: weekly.resetsAt,
    });
  }

  return measurements;
}

/**
 * Numerically configured windows must be present in the vendor report;
 * `null` thresholds are monitor-only and optional. An omitted numeric gate
 * is unknown usage so failClosed can block instead of silently allowing.
 */
function missingGates(
  agent: GuardAgent,
  config: Config,
  measurements: WindowMeasurement[],
): string | null {
  const present = new Set(measurements.map((m) => m.windowId));
  const needed: WindowMeasurement["windowId"][] = [];
  if (agent === "claude") {
    if (config.claude.windows.weekly.blockAtPercent !== null) needed.push("weekly");
    if (config.claude.windows.five_hour.blockAtPercent !== null) needed.push("five_hour");
  } else {
    if (config.codex.windows.weekly.blockAtPercent !== null) needed.push("weekly");
    if (config.codex.windows.session.blockAtPercent !== null) needed.push("session");
  }
  const missing = needed.filter((id) => !present.has(id));
  if (missing.length === 0) return null;
  return `Usage API did not report the ${missing.join(", ")} window(s) for ${agent}`;
}

function pctDisplay(usedPct: number | null): string {
  return usedPct === null ? "unknown" : formatPercent(usedPct);
}

const TOOL_LABELS = {
  claude: "Claude Code",
  codex: "Codex",
} satisfies Record<GuardAgent, string>;

/** Render the user-facing deny message (session id + escape hatches). */
export function formatGuardDeny(
  decision: Pick<GuardDecision, "evaluation">,
  agent: GuardAgent,
  sessionId?: string,
): string {
  const evaluation = decision.evaluation;
  const id = sessionId?.trim() || "unknown";
  const tool = TOOL_LABELS[agent];
  const lines = [`${tool} blocked by llm-budget.`, "", `Session id: ${id}`, ""];

  const primary = evaluation.reasons[0];
  if (primary) {
    if (primary.kind === "usageUnknown") {
      lines.push("Usage could not be determined:");
      lines.push(`  ${primary.detail}`);
      lines.push("");
      lines.push("Blocked because enforcement.failClosed is on (the default).");
    } else if (primary.kind === "window") {
      const now = new Date();
      lines.push(`${primary.windowLabel} budget reached:`);
      lines.push(
        `  ${formatPercent(primary.usedPct)} of ${formatPercent(primary.blockAtPercent)} block threshold`,
        `  ${primary.usedDisplay} / ${primary.denomDisplay}`,
      );
      if (primary.resetsAt)
        lines.push(`  Resets: ${primary.resetsAt}${formatResetCountdown(primary.resetsAt, now)}`);
      const informational = (evaluation.displayMeasurements ?? []).filter(
        (m) => m.blockAtPercent === null && m.windowId !== primary.windowId,
      );
      for (const m of informational) {
        lines.push("");
        lines.push(`${m.label}:`);
        lines.push(`  ${m.usedDisplay} / ${m.denomDisplay}`);
        if (m.resetsAt) lines.push(`  Resets: ${m.resetsAt}${formatResetCountdown(m.resetsAt, now)}`);
      }
    }
    lines.push("");
  }

  lines.push("Run:");
  lines.push("  llm-budget status");
  lines.push("  llm-budget override 30m");
  lines.push(`  llm-budget except add ${id}`);
  return lines.join("\n");
}
