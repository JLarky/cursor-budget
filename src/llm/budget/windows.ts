/**
 * Window ids for Claude Code and Codex. Separate from Cursor Agent's
 * dashboard-meter ids so block messages name the right tool.
 */
export type BudgetWindowId =
  | "claudeWeekly"
  | "claudeRolling"
  | "codexWeekly"
  | "usageUnknown";

export { parseDuration } from "../../budget/windows.js";
