import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateBudget,
  formatAge,
  formatResetCountdown,
  formatUsd,
  formatWindowBar,
  formatWindowLine,
  parseResetRemaining,
  renderProgressBar,
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
    formatWindowLine(
      measurement({ usedPct: 2, blockAtPercent: null, resetsAt: "2026-08-31T00:00:00.000Z" }),
      NOW,
    ),
    "Weekly: 2% (monitor-only) — resets 2026-08-31T00:00:00.000Z (in 11 days and 8 hours)",
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

test("formatWindowLine prints unmetered as no weekly percent and still names the armed gate", () => {
  assert.equal(
    formatWindowLine(
      measurement({
        usedPct: Number.NaN,
        usedDisplay: "no weekly percent",
        blockAtPercent: 80,
        meter: { kind: "unmetered" },
      }),
    ),
    "Weekly: no weekly percent (block at 80%)",
  );
  assert.equal(
    formatWindowLine(
      measurement({
        usedPct: Number.NaN,
        usedDisplay: "no weekly percent",
        blockAtPercent: null,
        meter: { kind: "unmetered" },
      }),
    ),
    "Weekly: no weekly percent (monitor-only)",
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

test("parseResetRemaining and formatResetCountdown cover remaining buckets", () => {
  const daysHoursAt = "2026-08-31T00:00:00.000Z";
  assert.deepEqual(parseResetRemaining(daysHoursAt, NOW), {
    kind: "days_hours",
    days: 11,
    hours: 8,
  });
  assert.equal(formatResetCountdown(daysHoursAt, NOW), " (in 11 days and 8 hours)");

  const exactlyOneDay = new Date(NOW.getTime() + 24 * 3_600_000).toISOString();
  assert.deepEqual(parseResetRemaining(exactlyOneDay, NOW), {
    kind: "days_hours",
    days: 1,
    hours: 0,
  });
  assert.equal(formatResetCountdown(exactlyOneDay, NOW), " (in 1 day)");

  const underADay = new Date(NOW.getTime() + 23 * 3_600_000 + 59 * 60_000).toISOString();
  assert.deepEqual(parseResetRemaining(underADay, NOW), {
    kind: "hours_minutes",
    hours: 23,
    minutes: 59,
  });
  assert.equal(formatResetCountdown(underADay, NOW), " (in 23 hours and 59 minutes)");

  const oneHour = new Date(NOW.getTime() + 3_600_000).toISOString();
  assert.deepEqual(parseResetRemaining(oneHour, NOW), {
    kind: "hours_minutes",
    hours: 1,
    minutes: 0,
  });
  assert.equal(formatResetCountdown(oneHour, NOW), " (in 1 hour)");

  const fortyFiveMinutes = new Date(NOW.getTime() + 45 * 60_000).toISOString();
  assert.equal(formatResetCountdown(fortyFiveMinutes, NOW), " (in 45 minutes)");

  const thirtySeconds = new Date(NOW.getTime() + 30_000).toISOString();
  assert.equal(parseResetRemaining(thirtySeconds, NOW).kind, "under_minute");
  assert.equal(formatResetCountdown(thirtySeconds, NOW), " (in less than a minute)");

  const past = new Date(NOW.getTime() - 1).toISOString();
  assert.equal(parseResetRemaining(past, NOW).kind, "past");
  assert.equal(formatResetCountdown(past, NOW), " (already reset)");

  assert.equal(parseResetRemaining("not-a-date", NOW).kind, "invalid");
  assert.equal(formatResetCountdown("not-a-date", NOW), "");
});

test("renderProgressBar fills proportionally and clamps out-of-range percents", () => {
  assert.equal(renderProgressBar(0, 20), "[░░░░░░░░░░░░░░░░░░░░] 0%");
  assert.equal(renderProgressBar(50, 20), "[██████████░░░░░░░░░░] 50%");
  assert.equal(renderProgressBar(100, 20), "[████████████████████] 100%");
  assert.equal(renderProgressBar(150, 20), "[████████████████████] 100%");
  assert.equal(renderProgressBar(-10, 20), "[░░░░░░░░░░░░░░░░░░░░] 0%");
});

test("renderProgressBar puts the block marker on the last cell that fills before the threshold", () => {
  // At exactly the block threshold, the marker must sit inside the filled
  // region, not one cell past it — otherwise the bar reads as still under
  // the limit at the exact point it actually blocks.
  assert.equal(renderProgressBar(0, 20, 80), "[░░░░░░░░░░░░░░░|░░░░] 0%");
  assert.equal(renderProgressBar(80, 20, 80), "[███████████████|░░░░] 80%");
  assert.equal(renderProgressBar(90, 20, 80), "[███████████████|██░░] 90%");
  assert.equal(renderProgressBar(100, 20, 80), "[███████████████|████] 100%");
});

test("formatWindowBar draws a bar only for measurable percents", () => {
  assert.equal(
    formatWindowBar(measurement({ usedPct: 42, blockAtPercent: null })),
    "[████████░░░░░░░░░░░░] 42%",
  );
  assert.equal(
    formatWindowBar(measurement({ usedPct: Number.NaN, usedDisplay: "unavailable" })),
    null,
  );
  assert.equal(
    formatWindowBar(measurement({ usedPct: Number.NaN, meter: { kind: "unmetered" } })),
    null,
  );
});
