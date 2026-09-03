import assert from "node:assert/strict";
import test from "node:test";
import { formatWindowLine } from "../budget/evaluator.js";
import { buildCopilotMeasurements } from "./copilot-measurements.js";
import type { ProviderUsage } from "./usage/types.js";

function copilot(windows: ProviderUsage["windows"]): ProviderUsage {
  return {
    providerId: "copilot",
    displayName: "GitHub Copilot",
    status: "available",
    planLabel: "Individual",
    windows,
    error: null,
  };
}

test("buildCopilotMeasurements maps known meters as monitor-only", () => {
  const measurements = buildCopilotMeasurements(
    copilot([
      { id: "chat", label: "Chat", usedPct: 1.7, resetsAt: "2026-10-01T00:00:00.000Z" },
      { id: "premium_interactions", label: "Premium requests", usedPct: 100, resetsAt: null },
    ]),
  );
  assert.equal(measurements.length, 2);
  assert.equal(measurements[0]?.windowId, "chat");
  assert.equal(measurements[0]?.blockAtPercent, null);
  assert.match(formatWindowLine(measurements[0]!), /^Chat: 1\.7% \(monitor-only\)/);
  assert.doesNotMatch(formatWindowLine(measurements[0]!), /block at/);
  assert.equal(formatWindowLine(measurements[1]!), "Premium requests: 100% (monitor-only)");
});

test("buildCopilotMeasurements omits meters the snapshot did not report", () => {
  const measurements = buildCopilotMeasurements(copilot([]));
  assert.equal(measurements.length, 0);
});
