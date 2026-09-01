import * as v from "valibot";
import type { GrokConfig } from "../config.js";

/**
 * A percent of xAI's own weekly pool, 0-100, finite. Minted only by `percent`,
 * so a value that has not passed through validation cannot be spent as a
 * measured percent — the "missing means 0%" bug has to get past the type
 * system first.
 */
const PercentSchema = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(0),
  v.maxValue(100),
  v.brand("Percent"),
);
export type Percent = v.InferOutput<typeof PercentSchema>;

export function percent(value: number): Percent | null {
  const parsed = v.safeParse(PercentSchema, value);
  return parsed.success ? parsed.output : null;
}

/** Where a measured percent came from, so a fallback is never mistaken for the real meter. */
export type ReadingSource = "creditUsagePercent" | "onDemandRatio";

/**
 * The weekly pool reading. There is no `number | null` and no NaN — "we don't
 * know" is a case, not a value. The two not-known cases are distinct because
 * their fixes are distinct: `unmetered` means xAI answered but this plan
 * publishes no weekly percent (retrying will not help; run monitor-only or
 * accept the fail-closed default). `unavailable` means we could not get a
 * fresh authenticated answer at all (retrying, or signing in, may help).
 */
export type Reading =
  | { readonly kind: "measured"; readonly percent: Percent; readonly source: ReadingSource }
  | { readonly kind: "unmetered"; readonly because: string }
  | { readonly kind: "unavailable"; readonly because: string };

/** xAI's weekly credit pool as the gate understands it. */
export interface GrokWeekly {
  readonly percent: Reading;
  readonly resetsAt: string | null;
  readonly planLabel: string | null;
  readonly fetchedAt: string;
}

/**
 * The configured gate, resolved. Replaces `{ blockAtPercent: number | null }`:
 * "monitor-only" and "block at zero" become different constructors instead of
 * different values of one nullable field, and only `armed` can carry a threshold.
 */
export type Gate =
  | { readonly kind: "armed"; readonly blockAtPercent: Percent }
  | { readonly kind: "monitorOnly" }
  | { readonly kind: "off" };

/**
 * What Grok asked us to authorize. `enforceable` exists only for
 * `pre_tool_use`, because that is the only Grok hook event whose decision
 * Grok honors. Every other event is `passive` by construction, so a future
 * caller cannot wire the budget gate to an event that silently does nothing.
 */
export type GrokRequest =
  | {
      readonly kind: "enforceable";
      readonly event: "pre_tool_use";
      readonly sessionId: string;
      readonly toolName: string | null;
    }
  | { readonly kind: "passive"; readonly event: string; readonly sessionId: string };

/**
 * Everything the gate depends on, resolved. One value, two consumers
 * (`decide` and `renderGrokStatus`), so status and enforcement cannot disagree.
 */
export interface GateState {
  readonly gate: Gate;
  readonly weekly: GrokWeekly;
  readonly overrideUntil: Date | null;
  readonly exceptedSessionIds: readonly string[];
  readonly failClosed: boolean;
  readonly now: Date;
}

export type AllowReason =
  | "gateOff"
  | "monitorOnly"
  | "sessionExcepted"
  | "overrideActive"
  | "underBudget"
  | "eventCannotDeny"
  | "failOpenConfigured";

export interface DenyReport {
  readonly sessionId: string;
  readonly weekly: GrokWeekly;
  readonly gate: Gate;
  readonly cause:
    | { readonly kind: "overBudget"; readonly used: Percent; readonly blockAt: Percent }
    | { readonly kind: "usageUnavailable"; readonly because: string }
    | { readonly kind: "usageUnmetered"; readonly because: string };
}

/**
 * The only thing that can discharge an armed gate. `decide` is total, so
 * "we couldn't decide" is not representable and cannot leak an allow.
 */
export type Verdict =
  | { readonly kind: "allow"; readonly why: AllowReason }
  | { readonly kind: "deny"; readonly report: DenyReport };

/**
 * Pure, total, deterministic. No I/O, no `new Date()`, no throw.
 *
 * Order is load-bearing: escape hatches first, so an expired token can never
 * lock a user out with no way back in.
 */
export function decide(state: GateState, request: GrokRequest): Verdict {
  if (request.kind === "passive") return { kind: "allow", why: "eventCannotDeny" };
  if (state.gate.kind === "off") return { kind: "allow", why: "gateOff" };
  if (state.exceptedSessionIds.includes(request.sessionId)) {
    return { kind: "allow", why: "sessionExcepted" };
  }
  if (state.overrideUntil !== null && state.overrideUntil.getTime() > state.now.getTime()) {
    return { kind: "allow", why: "overrideActive" };
  }
  if (state.gate.kind === "monitorOnly") return { kind: "allow", why: "monitorOnly" };

  const gate = state.gate;
  const reading = state.weekly.percent;
  switch (reading.kind) {
    case "measured": {
      if (reading.percent >= gate.blockAtPercent) {
        return {
          kind: "deny",
          report: {
            sessionId: request.sessionId,
            weekly: state.weekly,
            gate,
            cause: { kind: "overBudget", used: reading.percent, blockAt: gate.blockAtPercent },
          },
        };
      }
      return { kind: "allow", why: "underBudget" };
    }
    case "unmetered": {
      if (!state.failClosed) return { kind: "allow", why: "failOpenConfigured" };
      return {
        kind: "deny",
        report: {
          sessionId: request.sessionId,
          weekly: state.weekly,
          gate,
          cause: { kind: "usageUnmetered", because: reading.because },
        },
      };
    }
    case "unavailable": {
      if (!state.failClosed) return { kind: "allow", why: "failOpenConfigured" };
      return {
        kind: "deny",
        report: {
          sessionId: request.sessionId,
          weekly: state.weekly,
          gate,
          cause: { kind: "usageUnavailable", because: reading.because },
        },
      };
    }
    default: {
      const _exhaustive: never = reading;
      return _exhaustive;
    }
  }
}

/** Resolve `config.grok` into a `Gate`. The only place a nullable threshold becomes a sum type. */
export function gateFromConfig(config: GrokConfig): Gate {
  if (!config.enabled) return { kind: "off" };
  const threshold = config.windows.weekly.blockAtPercent;
  if (threshold === null) return { kind: "monitorOnly" };
  const blockAtPercent = percent(threshold);
  // Config validation already constrains blockAtPercent to 0-100; this is the
  // one place that fact has to be re-proven to the type system.
  if (blockAtPercent === null) return { kind: "monitorOnly" };
  return { kind: "armed", blockAtPercent };
}

/** The deny reason Grok shows the model and the user. Derived from `DenyReport`. */
export function renderDenyReason(report: DenyReport): string {
  const id = report.sessionId || "unknown";
  const lines = [`Grok CLI blocked by llm-budget. Session id: ${id}.`];
  switch (report.cause.kind) {
    case "overBudget":
      lines.push(
        `Weekly usage ${report.cause.used}% reached the ${report.cause.blockAt}% block threshold.`,
      );
      break;
    case "usageUnmetered":
      lines.push(
        `Weekly usage is not metered on this plan (${report.cause.because}). Blocked because enforcement.failClosed is on.`,
      );
      break;
    case "usageUnavailable":
      lines.push(
        `Weekly usage is unavailable (${report.cause.because}). Blocked because enforcement.failClosed is on.`,
      );
      break;
    default: {
      const _exhaustive: never = report.cause;
      return _exhaustive;
    }
  }
  lines.push(
    `Recover with: llm-budget grok override 30m | llm-budget grok except add ${id} | llm-budget grok status`,
  );
  return lines.join(" ");
}

export interface HookInstallState {
  readonly installed: boolean;
}

/**
 * The `Grok CLI:` status body, one line per entry, unindented. Reads the same
 * `GateState` `decide` reads, so the number in `llm-budget status` is
 * provably the number the gate enforces.
 */
export function renderGrokStatus(state: GateState, hooks: HookInstallState): readonly string[] {
  const lines: string[] = [
    `Hooks: ${hooks.installed ? "installed" : "not installed — run llm-budget grok install"}`,
  ];
  if (state.gate.kind === "off") {
    lines.push("disabled in config");
    return lines;
  }
  lines.push(renderWeeklyLine(state.weekly, state.gate));
  const overrideActive =
    state.overrideUntil !== null && state.overrideUntil.getTime() > state.now.getTime();
  lines.push(
    `Override: ${overrideActive ? `until ${state.overrideUntil?.toLocaleString()}` : "none"}`,
  );
  lines.push(
    `Exceptions: ${state.exceptedSessionIds.length > 0 ? state.exceptedSessionIds.join(", ") : "none"}`,
  );
  return lines;
}

function renderWeeklyLine(weekly: GrokWeekly, gate: Gate): string {
  const resetSuffix = weekly.resetsAt ? ` — resets ${weekly.resetsAt}` : "";
  const gateSuffix = gate.kind === "armed" ? `block at ${gate.blockAtPercent}%` : "monitor-only";
  const reading = weekly.percent;
  switch (reading.kind) {
    case "measured":
      return `Weekly: ${reading.percent}% (${gateSuffix})${resetSuffix}`;
    case "unmetered":
      return `Weekly: not metered on this plan — ${reading.because} (${gateSuffix})${resetSuffix}`;
    case "unavailable":
      return `Weekly: unavailable — ${reading.because} (${gateSuffix})${resetSuffix}`;
    default: {
      const _exhaustive: never = reading;
      return _exhaustive;
    }
  }
}
