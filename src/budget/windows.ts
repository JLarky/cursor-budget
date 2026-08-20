export type WindowId =
  | "rollingHour"
  | "cursorModels"
  | "otherModels"
  | "totalQuota"
  | "usageUnknown";

export interface TimeWindow {
  id: WindowId;
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
