import assert from "node:assert/strict";
import test from "node:test";
import {
  decide,
  gateFromConfig,
  percent,
  renderDenyReason,
  renderGrokStatus,
  type GateState,
  type Gate,
  type GrokRequest,
  type GrokWeekly,
} from "./policy.js";
import { DEFAULT_CONFIG } from "../config.js";

const NOW = new Date("2026-09-01T00:00:00.000Z");

function measuredWeekly(pct: number): GrokWeekly {
  const p = percent(pct);
  assert.ok(p !== null, "test fixture percent must be valid");
  return {
    percent: { kind: "measured", percent: p, source: "creditUsagePercent" },
    resetsAt: "2026-09-08T00:00:00.000Z",
    planLabel: null,
    fetchedAt: NOW.toISOString(),
  };
}

function unmeteredWeekly(): GrokWeekly {
  return {
    percent: { kind: "unmetered", because: "plan does not report a percent" },
    resetsAt: "2026-09-08T00:00:00.000Z",
    planLabel: null,
    fetchedAt: NOW.toISOString(),
  };
}

function unavailableWeekly(): GrokWeekly {
  return {
    percent: { kind: "unavailable", because: "expired credential" },
    resetsAt: null,
    planLabel: null,
    fetchedAt: NOW.toISOString(),
  };
}

const BLOCK_AT_80 = percent(80);
assert.ok(BLOCK_AT_80 !== null, "test fixture percent must be valid");
const ARMED_80: Gate = { kind: "armed", blockAtPercent: BLOCK_AT_80 };

function state(overrides: Partial<GateState> = {}): GateState {
  return {
    gate: ARMED_80,
    weekly: measuredWeekly(10),
    overrideUntil: null,
    exceptedSessionIds: [],
    failClosed: true,
    now: NOW,
    ...overrides,
  };
}

function enforceable(sessionId = "sess-1"): GrokRequest {
  return { kind: "enforceable", event: "pre_tool_use", sessionId, toolName: "run_terminal_command" };
}

test("passive events never deny, even with a hot gate", () => {
  const verdict = decide(state({ weekly: measuredWeekly(99) }), {
    kind: "passive",
    event: "user_prompt_submit",
    sessionId: "sess-1",
  });
  assert.deepEqual(verdict, { kind: "allow", why: "eventCannotDeny" });
});

test("gate off allows regardless of usage", () => {
  const verdict = decide(state({ gate: { kind: "off" }, weekly: measuredWeekly(99) }), enforceable());
  assert.deepEqual(verdict, { kind: "allow", why: "gateOff" });
});

test("excepted session bypasses an armed gate", () => {
  const verdict = decide(
    state({ weekly: measuredWeekly(99), exceptedSessionIds: ["sess-1"] }),
    enforceable("sess-1"),
  );
  assert.deepEqual(verdict, { kind: "allow", why: "sessionExcepted" });
});

test("active override bypasses an armed gate", () => {
  const overrideUntil = new Date(NOW.getTime() + 60_000);
  const verdict = decide(state({ weekly: measuredWeekly(99), overrideUntil }), enforceable());
  assert.deepEqual(verdict, { kind: "allow", why: "overrideActive" });
});

test("expired override does not bypass", () => {
  const overrideUntil = new Date(NOW.getTime() - 60_000);
  const verdict = decide(state({ weekly: measuredWeekly(99), overrideUntil }), enforceable());
  assert.equal(verdict.kind, "deny");
});

test("monitor-only never denies, even over threshold", () => {
  const verdict = decide(
    state({ gate: { kind: "monitorOnly" }, weekly: measuredWeekly(99) }),
    enforceable(),
  );
  assert.deepEqual(verdict, { kind: "allow", why: "monitorOnly" });
});

test("armed and under threshold allows", () => {
  const verdict = decide(state({ weekly: measuredWeekly(79) }), enforceable());
  assert.deepEqual(verdict, { kind: "allow", why: "underBudget" });
});

test("armed and at or over threshold denies", () => {
  const at = decide(state({ weekly: measuredWeekly(80) }), enforceable());
  assert.equal(at.kind, "deny");
  const over = decide(state({ weekly: measuredWeekly(95) }), enforceable());
  assert.equal(over.kind, "deny");
});

test("armed + unmetered denies under failClosed, allows when off", () => {
  const closed = decide(state({ weekly: unmeteredWeekly(), failClosed: true }), enforceable());
  assert.equal(closed.kind, "deny");
  if (closed.kind === "deny") assert.equal(closed.report.cause.kind, "usageUnmetered");

  const open = decide(state({ weekly: unmeteredWeekly(), failClosed: false }), enforceable());
  assert.deepEqual(open, { kind: "allow", why: "failOpenConfigured" });
});

test("armed + unavailable denies under failClosed, allows when off", () => {
  const closed = decide(state({ weekly: unavailableWeekly(), failClosed: true }), enforceable());
  assert.equal(closed.kind, "deny");
  if (closed.kind === "deny") assert.equal(closed.report.cause.kind, "usageUnavailable");

  const open = decide(state({ weekly: unavailableWeekly(), failClosed: false }), enforceable());
  assert.deepEqual(open, { kind: "allow", why: "failOpenConfigured" });
});

test("percent rejects out-of-range and non-finite values, accepts the boundary", () => {
  assert.equal(percent(0), 0);
  assert.equal(percent(100), 100);
  assert.equal(percent(-1), null);
  assert.equal(percent(101), null);
  assert.equal(percent(Number.NaN), null);
});

test("gateFromConfig maps disabled, monitor-only, and armed", () => {
  const grok = DEFAULT_CONFIG.grok;
  assert.deepEqual(gateFromConfig({ ...grok, enabled: false }), { kind: "off" });
  assert.deepEqual(
    gateFromConfig({ ...grok, windows: { weekly: { blockAtPercent: null } } }),
    { kind: "monitorOnly" },
  );
  assert.deepEqual(gateFromConfig(grok), { kind: "armed", blockAtPercent: 80 });
});

test("renderDenyReason names the session id and the recover commands", () => {
  const verdict = decide(state({ weekly: measuredWeekly(90) }), enforceable("sess-abc"));
  assert.equal(verdict.kind, "deny");
  if (verdict.kind !== "deny") return;
  const reason = renderDenyReason(verdict.report);
  assert.match(reason, /sess-abc/);
  assert.match(reason, /90% reached the 80% block threshold/);
  assert.match(reason, /llm-budget grok except add sess-abc/);
});

test("status distinguishes not-metered from unavailable", () => {
  const unmetered = renderGrokStatus(state({ weekly: unmeteredWeekly() }), { installed: true });
  assert.match(
    unmetered.join("\n"),
    /Weekly: no weekly percent \(block at 80%\) — resets 2026-09-08T00:00:00.000Z \(in 7 days\)/,
  );
  assert.doesNotMatch(unmetered.join("\n"), /not metered/);
  assert.doesNotMatch(unmetered.join("\n"), /plan does not report a percent/);

  const unavailable = renderGrokStatus(state({ weekly: unavailableWeekly() }), { installed: true });
  assert.match(unavailable.join("\n"), /Weekly: unavailable \(usage unknown\)/);
  assert.doesNotMatch(unavailable.join("\n"), /not metered/);
  assert.doesNotMatch(unavailable.join("\n"), /expired credential/);
  assert.doesNotMatch(unavailable.join("\n"), /resets /);
});

test("status shows disabled without a weekly line when the gate is off", () => {
  const lines = renderGrokStatus(state({ gate: { kind: "off" } }), { installed: false });
  assert.deepEqual(lines, [
    "Hooks: not installed — run llm-budget grok install",
    "disabled in config",
  ]);
});
