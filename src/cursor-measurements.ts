import type { CursorPlanUsage } from "./accounting/cursor-api.js";
import { formatNullablePercent, type WindowMeasurement } from "./budget/evaluator.js";
import type { Config } from "./config.js";

/**
 * Build Cursor's window measurements from the dashboard plan usage,
 * shared by the guard (`hook.ts`) and every status view so the same numbers
 * and thresholds render everywhere.
 */
export function buildCursorMeasurements(config: Config, plan: CursorPlanUsage): WindowMeasurement[] {
  const measurements: WindowMeasurement[] = [];
  if (plan.autoPercentUsed != null) {
    measurements.push({
      windowId: "cursorModels",
      label: "Cursor Models",
      usedPct: plan.autoPercentUsed,
      blockAtPercent: config.cursor.windows.cursorModels.blockAtPercent,
      usedDisplay: formatNullablePercent(plan.autoPercentUsed),
      denomDisplay: "Cursor Models window",
    });
  }
  if (plan.apiPercentUsed != null) {
    measurements.push({
      windowId: "otherModels",
      label: "Other Models",
      usedPct: plan.apiPercentUsed,
      blockAtPercent: config.cursor.windows.otherModels.blockAtPercent,
      usedDisplay: formatNullablePercent(plan.apiPercentUsed),
      denomDisplay: "Other Models window",
    });
  }
  if (plan.totalPercentUsed != null) {
    measurements.push({
      windowId: "total",
      label: "Total",
      usedPct: plan.totalPercentUsed,
      blockAtPercent: config.cursor.windows.total.blockAtPercent,
      usedDisplay: formatNullablePercent(plan.totalPercentUsed),
      denomDisplay: "Total window",
    });
  }
  return measurements;
}
