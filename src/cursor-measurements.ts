import type { CursorPlanUsage } from "./accounting/cursor-api.js";
import { formatNullablePercent, type WindowMeasurement } from "./budget/evaluator.js";
import type { Config } from "./config.js";
import type { WindowId } from "./budget/windows.js";

function pushCursorWindow(
  measurements: WindowMeasurement[],
  windowId: WindowId,
  label: string,
  vendorPct: number | null | undefined,
  blockAtPercent: number | null,
  denomDisplay: string,
): void {
  measurements.push({
    windowId,
    label,
    usedPct: vendorPct ?? Number.NaN,
    blockAtPercent,
    usedDisplay: vendorPct != null ? formatNullablePercent(vendorPct) : "unavailable",
    denomDisplay,
  });
}

/**
 * Build Cursor's window measurements from the dashboard plan usage,
 * shared by the guard (`hook.ts`) and every status view so the same numbers
 * and thresholds render everywhere. Configured windows stay visible even when
 * the vendor meter is null — shown as unavailable, not omitted.
 */
export function buildCursorMeasurements(config: Config, plan: CursorPlanUsage): WindowMeasurement[] {
  const measurements: WindowMeasurement[] = [];
  pushCursorWindow(
    measurements,
    "cursorModels",
    "Cursor Models",
    plan.autoPercentUsed,
    config.cursor.windows.cursorModels.blockAtPercent,
    "Cursor Models window",
  );
  pushCursorWindow(
    measurements,
    "otherModels",
    "Other Models",
    plan.apiPercentUsed,
    config.cursor.windows.otherModels.blockAtPercent,
    "Other Models window",
  );
  pushCursorWindow(
    measurements,
    "total",
    "Total",
    plan.totalPercentUsed,
    config.cursor.windows.total.blockAtPercent,
    "Total window",
  );
  return measurements;
}
