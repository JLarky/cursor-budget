import assert from "node:assert/strict";
import test from "node:test";
import { tempHome } from "../test-home.js";
import {
  GrokHookInputError,
  grokExceptCommand,
  grokGateState,
  grokOverrideCommand,
  grokStatusSection,
  parseGrokRequest,
} from "./scope.js";
import { decide } from "./policy.js";

test("parseGrokRequest recognizes every pre_tool_use spelling as enforceable", () => {
  for (const spelling of ["pre_tool_use", "PreToolUse", "preToolUse"]) {
    const request = parseGrokRequest(
      JSON.stringify({ hookEventName: spelling, sessionId: "sess-1", toolName: "run_terminal_command" }),
    );
    assert.deepEqual(request, {
      kind: "enforceable",
      event: "pre_tool_use",
      sessionId: "sess-1",
      toolName: "run_terminal_command",
    });
  }
});

test("parseGrokRequest accepts Claude's snake_case aliases", () => {
  const request = parseGrokRequest(
    JSON.stringify({ hook_event_name: "pre_tool_use", session_id: "sess-2" }),
  );
  assert.equal(request.kind, "enforceable");
  assert.equal(request.sessionId, "sess-2");
});

test("parseGrokRequest treats an unenforceable event as passive, not a deny", () => {
  const request = parseGrokRequest(
    JSON.stringify({ hookEventName: "user_prompt_submit", sessionId: "sess-3" }),
  );
  assert.deepEqual(request, { kind: "passive", event: "user_prompt_submit", sessionId: "sess-3" });
});

test("empty or non-JSON-object stdin fails closed by throwing, not by allowing", () => {
  assert.throws(() => parseGrokRequest(""), GrokHookInputError);
  assert.throws(() => parseGrokRequest("   "), GrokHookInputError);
  assert.throws(() => parseGrokRequest("{ not json"), GrokHookInputError);
  assert.throws(() => parseGrokRequest('"just a string"'), GrokHookInputError);
});

test("with no Grok auth in an isolated home, the gate is unavailable and armed by default fails closed", async () => {
  const home = tempHome("llm-budget-grok-gate-");
  const state = await grokGateState({ home, now: new Date("2026-09-01T00:00:00.000Z") });
  assert.equal(state.weekly.percent.kind, "unavailable");
  assert.deepEqual(state.gate, { kind: "armed", blockAtPercent: 80 });

  const verdict = decide(state, {
    kind: "enforceable",
    event: "pre_tool_use",
    sessionId: "sess-1",
    toolName: null,
  });
  assert.equal(verdict.kind, "deny");
  if (verdict.kind === "deny") assert.equal(verdict.report.cause.kind, "usageUnavailable");
});

test("an active override reaches allow even with unavailable usage", async () => {
  const home = tempHome("llm-budget-grok-override-");
  grokOverrideCommand("30m", home);
  const state = await grokGateState({ home, now: new Date() });
  const verdict = decide(state, {
    kind: "enforceable",
    event: "pre_tool_use",
    sessionId: "sess-1",
    toolName: null,
  });
  assert.deepEqual(verdict, { kind: "allow", why: "overrideActive" });

  const cleared = grokOverrideCommand("off", home);
  assert.match(cleared, /Override cleared/);
});

test("except add, list, and remove a Grok session id", () => {
  const home = tempHome("llm-budget-grok-except-");
  const added = grokExceptCommand(["add", "sess-except-1"], home);
  assert.match(added, /Excepted sess-except-1/);
  assert.match(grokExceptCommand(["list"], home), /sess-except-1/);
  const removed = grokExceptCommand(["remove", "sess-except-1"], home);
  assert.match(removed, /Removed exception/);
  assert.match(grokExceptCommand(["list"], home), /No session exceptions/);
});

test("status section names the block and distinguishes unavailable from not-installed", async () => {
  const home = tempHome("llm-budget-grok-status-");
  const section = await grokStatusSection(home, new Date());
  assert.match(section, /^Grok CLI:/);
  assert.match(section, /Hooks: not installed — run llm-budget grok install/);
  assert.match(section, /Weekly: unavailable/);
  assert.match(section, /Override: none/);
  assert.match(section, /Exceptions: none/);
});
