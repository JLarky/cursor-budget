import assert from "node:assert/strict";
import test from "node:test";
import { formatWindowLine } from "./budget/evaluator.js";
import { DEFAULT_CONFIG } from "./config.js";
import { buildCursorMeasurements } from "./cursor-measurements.js";

test("configured Cursor windows stay visible when vendor meter is null", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const measurements = buildCursorMeasurements(config, {
    totalSpendCents: 0,
    includedSpendCents: 0,
    bonusSpendCents: 0,
    remainingCents: 0,
    limitCents: null,
    totalSpendUsd: 0,
    includedSpendUsd: 0,
    bonusSpendUsd: 0,
    remainingUsd: 0,
    limitUsd: null,
    autoPercentUsed: null,
    apiPercentUsed: 0.5,
    totalPercentUsed: null,
    remainingBonus: false,
    bonusTooltip: null,
  });

  assert.equal(measurements.length, 3);
  const cursorModels = measurements.find((m) => m.windowId === "cursorModels");
  const total = measurements.find((m) => m.windowId === "total");
  assert.equal(cursorModels?.usedDisplay, "unavailable");
  assert.equal(total?.usedDisplay, "unavailable");
  assert.equal(formatWindowLine(cursorModels!), "Cursor Models: unavailable (usage unknown)");
  assert.equal(formatWindowLine(total!), "Total: unavailable (monitor-only)");
  assert.doesNotMatch(formatWindowLine(cursorModels!), /block at/);
});
