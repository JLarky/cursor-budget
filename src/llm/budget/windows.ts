import type { WindowId as CursorWindowId } from "../../budget/windows.js";

/**
 * Window ids for the Claude/Codex guard. Distinct from cursor-budget's
 * `WindowId`s; reusing the label namespace would make block messages lie
 * about which tool tripped.
 */
export type BudgetWindowId =
  | "claudeWeekly"
  | "claudeRolling"
  | "codexWeekly"
  | "usageUnknown";

// Keep the cursor module imported for `parseDuration` reuse below.
export { parseDuration, rollingHour } from "../../budget/windows.js";
export type { CursorWindowId };

const DAY_MS = 86_400_000;

/**
 * Start of the current pinned UTC week (Monday 00:00 UTC).
 *
 * OpenAI does not document Codex's exact weekly boundary, so we pin one:
 * Monday 00:00 UTC. It is deterministic across machines and timezones, and
 * the choice is documented in the README. If OpenAI's real anchor differs,
 * the worst case is a week that rolls a few days off from theirs.
 */
export function utcWeekStart(now: Date): Date {
  const day = now.getUTCDay(); // 0 = Sunday
  const daysSinceMonday = (day + 6) % 7;
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - daysSinceMonday,
      0,
      0,
      0,
      0,
    ),
  );
}

export function nextUtcWeekStart(now: Date): Date {
  return new Date(utcWeekStart(now).getTime() + 7 * DAY_MS);
}

/** Start of a rolling window ending at `now`. */
export function rollingWindowStart(now: Date, windowMs: number): Date {
  return new Date(now.getTime() - windowMs);
}
