import { formatPercent, type WindowMeasurement } from "../budget/evaluator.js";
import type { WindowId } from "../budget/windows.js";
import type { ProviderUsage } from "./usage/types.js";

const METERS: ReadonlyArray<{ id: WindowId; denomDisplay: string }> = [
  { id: "chat", denomDisplay: "Copilot chat limit" },
  { id: "completions", denomDisplay: "Copilot completions limit" },
  { id: "premium_interactions", denomDisplay: "Copilot premium-request limit" },
];

/**
 * Map Copilot's usage windows into status measurements. Every Copilot meter
 * is monitor-only: Copilot CLI has no hook, so nothing here is enforced.
 */
export function buildCopilotMeasurements(provider: ProviderUsage): WindowMeasurement[] {
  const measurements: WindowMeasurement[] = [];
  for (const meter of METERS) {
    const window = provider.windows.find((w) => w.id === meter.id);
    if (!window) continue;
    measurements.push({
      windowId: meter.id,
      label: window.label,
      usedPct: window.usedPct ?? Number.NaN,
      blockAtPercent: null,
      usedDisplay: window.usedPct == null ? "unknown" : formatPercent(window.usedPct),
      denomDisplay: meter.denomDisplay,
      resetsAt: window.resetsAt,
    });
  }
  return measurements;
}