import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBudget, formatBudgetBlockMessage } from "./evaluator.js";
import type { WindowMeasurement } from "./evaluator.js";

const NOW = new Date("2026-08-19T15:30:00.000Z");

function measurement(overrides: Partial<WindowMeasurement> = {}): WindowMeasurement {
  return {
    windowId: "claudeWeekly",
    label: "Weekly budget",
    usedPct: 10,
    blockAtPct: 80,
    usedDisplay: "10%",
    denomDisplay: "provider weekly limit",
    ...overrides,
  };
}

test("allows under every threshold", () => {
  const result = evaluateBudget({
    measurements: [measurement()],
    overrideUntil: null,
    now: NOW,
  });
  assert.equal(result.allow, true);
  assert.equal(result.reasons.length, 0);
});

test("blocks at and above the threshold, not below", () => {
  const at = evaluateBudget({
    measurements: [measurement({ usedPct: 80 })],
    overrideUntil: null,
    now: NOW,
  });
  assert.equal(at.allow, false);

  const over = evaluateBudget({
    measurements: [measurement({ usedPct: 80.01 })],
    overrideUntil: null,
    now: NOW,
  });
  assert.equal(over.allow, false);

  const under = evaluateBudget({
    measurements: [measurement({ usedPct: 79.99 })],
    overrideUntil: null,
    now: NOW,
  });
  assert.equal(under.allow, true);
});

test("any tripped window among several blocks", () => {
  const result = evaluateBudget({
    measurements: [
      measurement({ windowId: "claudeWeekly", usedPct: 5 }),
      measurement({
        windowId: "claudeRolling",
        label: "Rolling 5h budget",
        usedPct: 91,
        blockAtPct: 90,
      }),
    ],
    overrideUntil: null,
    now: NOW,
  });
  assert.equal(result.allow, false);
  assert.equal(result.reasons[0]?.windowId, "claudeRolling");
});

test("override short-circuits before any gate", () => {
  const result = evaluateBudget({
    measurements: [measurement({ usedPct: 100 })],
    overrideUntil: new Date(NOW.getTime() + 60_000),
    now: NOW,
  });
  assert.equal(result.allow, true);
  assert.equal(result.overrideActive, true);
});

test("expired overrides do not apply", () => {
  const result = evaluateBudget({
    measurements: [measurement({ usedPct: 100 })],
    overrideUntil: new Date(NOW.getTime() - 60_000),
    now: NOW,
  });
  assert.equal(result.allow, false);
});

test("excluded sessions bypass everything", () => {
  const result = evaluateBudget({
    measurements: [measurement({ usedPct: 100 })],
    overrideUntil: null,
    now: NOW,
    excluded: true,
  });
  assert.equal(result.allow, true);
  assert.equal(result.excluded, true);
});

test("failClosed turns unknown usage into a block with detail", () => {
  const blocked = evaluateBudget({
    measurements: [],
    overrideUntil: null,
    now: NOW,
    failClosed: true,
    usageUnknownReason: "provider usage could not be read",
  });
  assert.equal(blocked.allow, false);
  assert.equal(blocked.reasons[0]?.windowId, "usageUnknown");
  assert.equal(blocked.reasons[0]?.detail, "provider usage could not be read");

  // failOpen only blocks when a real threshold trips.
  const open = evaluateBudget({
    measurements: [],
    overrideUntil: null,
    now: NOW,
    failClosed: false,
    usageUnknownReason: "db unreadable",
  });
  assert.equal(open.allow, true);

  // But an explicit measurement still blocks under failClosed.
  const measured = evaluateBudget({
    measurements: [measurement({ usedPct: 95 })],
    overrideUntil: null,
    now: NOW,
    failClosed: true,
    usageUnknownReason: null,
  });
  assert.equal(measured.allow, false);
});

test("block message prints session id and escape hatches", () => {
  const evaluation = evaluateBudget({
    measurements: [measurement({ usedPct: 85 })],
    overrideUntil: null,
    now: NOW,
  });
  const message = formatBudgetBlockMessage(evaluation, "claude", "sess-1234");
  assert.match(message, /Session id: sess-1234/);
  assert.match(message, /llm-budget override 30m/);
  assert.match(message, /llm-budget except add sess-1234/);
  assert.match(message, /85%/);
});
