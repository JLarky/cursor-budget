/**
 * Window ids shared by every agent's usage windows plus the local
 * rolling-hour event-count backstop. Claude, Codex, and Copilot ids match
 * the vendor's own window names; Cursor ids match the dashboard meter names.
 */
export type WindowId =
  | "weekly"
  | "five_hour"
  | "session"
  | "chat"
  | "completions"
  | "premium_interactions"
  | "cursorModels"
  | "otherModels"
  | "total"
  | "rollingHour"
  | "usageUnknown";

export interface TimeWindow {
  id: "rollingHour";
  from: Date;
  to: Date;
  label: string;
}

export function rollingHour(now = new Date()): TimeWindow {
  const from = new Date(now.getTime() - 60 * 60 * 1000);
  return {
    id: "rollingHour",
    from,
    to: now,
    label: "Last 60 minutes",
  };
}

export function parseDuration(input: string): number | null {
  const match = input.trim().match(/^(\d+)(m|h|d)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  return amount * 24 * 60 * 60 * 1000;
}
