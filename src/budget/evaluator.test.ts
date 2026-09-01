import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateBudget,
  formatAge,
  formatUsd,
  formatWindowLine,
  type WindowMeasurement,
} from "./evaluator.js";

const NOW = new Date("2026-08-19T15:30:00.000Z");

function measurement(overrides: Partial<WindowMeasurement> = {}): WindowMeasurement {
  return {
    windowId: "weekly",
    label: "Weekly",
    usedPct: 10,
    blockAtPercent: 80,
    usedDisplay: "10%",
    denomDisplay: "provider weekly limit",
    ...overrides,
  };
}

test("allows under every threshold", () => {
  const result = evaluateBudget({ measurements: [measurement()], overrideUntil: null, now: NOW });
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

test("blockAtPercent: null is monitor-only, never enforced", () => {
  const result = evaluateBudget({
    measurements: [measurement({ usedPct: 100, blockAtPercent: null })],
    overrideUntil: null,
    now: NOW,
  });
  assert.equal(result.allow, true);
  assert.equal(result.reasons.length, 0);
});

test("any tripped window among several blocks", () => {
  const result = evaluateBudget({
    measurements: [
      measurement({ windowId: "weekly", usedPct: 5 }),
      measurement({ windowId: "five_hour", label: "Rolling 5h", usedPct: 91, blockAtPercent: 90 }),
    ],
    overrideUntil: null,
    now: NOW,
  });
  assert.equal(result.allow, false);
  assert.equal(result.reasons[0]?.kind, "window");
  assert.equal(result.reasons[0]?.kind === "window" ? result.reasons[0].windowId : null, "five_hour");
});

test("event-rate backstop blocks independently of window measurements", () => {
  const result = evaluateBudget({
    measurements: [measurement({ usedPct: 1 })],
    eventRate: { used: 500, limit: 500 },
    overrideUntil: null,
    now: NOW,
  });
  assert.equal(result.allow, false);
  assert.equal(result.reasons[0]?.kind, "eventRate");

  const disabled = evaluateBudget({
    measurements: [measurement({ usedPct: 1 })],
    eventRate: { used: 999, limit: null },
    overrideUntil: null,
    now: NOW,
  });
  assert.equal(disabled.allow, true);
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
  assert.equal(blocked.reasons[0]?.kind, "usageUnknown");
  assert.equal(
    blocked.reasons[0]?.kind === "usageUnknown" ? blocked.reasons[0].detail : null,
    "provider usage could not be read",
  );

  const open = evaluateBudget({
    measurements: [],
    overrideUntil: null,
    now: NOW,
    failClosed: false,
    usageUnknownReason: "db unreadable",
  });
  assert.equal(open.allow, true);

  const measured = evaluateBudget({
    measurements: [measurement({ usedPct: 95 })],
    overrideUntil: null,
    now: NOW,
    failClosed: true,
    usageUnknownReason: null,
  });
  assert.equal(measured.allow, false);
});

test("a tripped window suppresses the unrelated usageUnknown reason", () => {
  const result = evaluateBudget({
    measurements: [measurement({ usedPct: 100 })],
    eventRate: { used: 999, limit: 500 },
    overrideUntil: null,
    now: NOW,
    failClosed: true,
    usageUnknownReason: "should not surface",
  });
  assert.equal(result.reasons.some((r) => r.kind === "usageUnknown"), false);
});

test("formatWindowLine distinguishes enforced from monitor-only", () => {
  assert.equal(
    formatWindowLine(measurement({ usedPct: 42, blockAtPercent: 80 })),
    "Weekly: 42% (block at 80%)",
  );
  assert.equal(
    formatWindowLine(measurement({ usedPct: 2, blockAtPercent: null })),
    "Weekly: 2% (monitor-only)",
  );
  assert.equal(
    formatWindowLine(measurement({ usedPct: 2, blockAtPercent: null, resetsAt: "2026-08-31T00:00:00.000Z" })),
    "Weekly: 2% (monitor-only) — resets 2026-08-31T00:00:00.000Z",
  );
});

test("formatWindowLine never advertises block-at for unavailable meters", () => {
  assert.equal(
    formatWindowLine(
      measurement({ usedPct: Number.NaN, usedDisplay: "unavailable", blockAtPercent: 90 }),
    ),
    "Weekly: unavailable (usage unknown)",
  );
  assert.equal(
    formatWindowLine(
      measurement({ usedPct: Number.NaN, usedDisplay: "unavailable", blockAtPercent: null }),
    ),
    "Weekly: unavailable (monitor-only)",
  );
});

test("unavailable enforced meters fail closed instead of advertising a pass", () => {
  const blocked = evaluateBudget({
    measurements: [
      measurement({
        windowId: "cursorModels",
        label: "Cursor Models",
        usedPct: Number.NaN,
        usedDisplay: "unavailable",
        blockAtPercent: 90,
      }),
      measurement({
        windowId: "otherModels",
        label: "Other Models",
        usedPct: 1,
        usedDisplay: "1%",
        blockAtPercent: 90,
      }),
    ],
    overrideUntil: null,
    now: NOW,
    failClosed: true,
  });
  assert.equal(blocked.allow, false);
  assert.equal(blocked.reasons[0]?.kind, "usageUnknown");
  if (blocked.reasons[0]?.kind === "usageUnknown") {
    assert.match(blocked.reasons[0].detail, /Cursor Models/);
  }

  const open = evaluateBudget({
    measurements: [
      measurement({
        windowId: "cursorModels",
        label: "Cursor Models",
        usedPct: Number.NaN,
        usedDisplay: "unavailable",
        blockAtPercent: 90,
      }),
    ],
    overrideUntil: null,
    now: NOW,
    failClosed: false,
  });
  assert.equal(open.allow, true);
});

test("monitor-only unavailable meters do not fail closed", () => {
  const result = evaluateBudget({
    measurements: [
      measurement({ usedPct: 10, blockAtPercent: 80 }),
      measurement({
        windowId: "total",
        label: "Total",
        usedPct: Number.NaN,
        usedDisplay: "unavailable",
        blockAtPercent: null,
      }),
    ],
    overrideUntil: null,
    now: NOW,
    failClosed: true,
  });
  assert.equal(result.allow, true);
});

test("formatUsd handles non-finite and sub-cent values", () => {
  assert.equal(formatUsd(Number.NaN), "$?—");
  assert.equal(formatUsd(0.006), "$0.006");
  assert.equal(formatUsd(1.5), "$1.50");
});

test("formatAge scales units", () => {
  assert.equal(formatAge(500), "500ms");
  assert.equal(formatAge(2_000), "2s");
  assert.equal(formatAge(120_000), "2m");
  assert.equal(formatAge(7_200_000), "2.0h");
});
