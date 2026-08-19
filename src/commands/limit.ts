import { ensureConfig, writeConfig, type Config, type Limit } from "../config.js";
import { formatTokens, formatUsd } from "../budget/evaluator.js";

const USAGE = `Usage:
  cursor-budget limit list
  cursor-budget limit hour usd 1
  cursor-budget limit day usd 4
  cursor-budget limit hour tokens 200000
  cursor-budget limit hour usd off
  cursor-budget limit day tokens off`;

type WindowName = "rollingHour" | "calendarDay";
type Metric = "usd" | "tokens";

export function limitCommand(args: string[], home?: string): string {
  const config = ensureConfig(home);
  const [a, b, c] = args;
  if (!a || a === "list") {
    return formatLimits(config);
  }
  if (a.startsWith("-")) {
    throw new Error(USAGE);
  }

  const window = parseWindow(a);
  if (!window) {
    throw new Error(USAGE);
  }

  if (!b) {
    throw new Error(USAGE);
  }

  let metric: Metric;
  let rawValue: string;
  if (b === "usd" || b === "tokens") {
    metric = b;
    rawValue = c ?? "";
  } else {
    metric = "usd";
    rawValue = b;
    if (c) throw new Error(USAGE);
  }
  if (!rawValue || rawValue.startsWith("-")) {
    throw new Error(USAGE);
  }

  const nextLimit: Limit = { ...config.limits[window] };
  nextLimit[metric] = parseLimitValue(metric, rawValue);
  const next: Config = {
    ...config,
    limits: {
      ...config.limits,
      [window]: nextLimit,
    },
  };
  writeConfig(next, home);
  return `Updated ${windowLabel(window)} ${metric} limit.\n${formatLimits(next)}`;
}

function parseWindow(raw: string): WindowName | null {
  const value = raw.toLowerCase();
  if (["hour", "hourly", "rollinghour", "60m"].includes(value)) return "rollingHour";
  if (["day", "daily", "calendarday", "today"].includes(value)) return "calendarDay";
  return null;
}

function parseLimitValue(metric: Metric, raw: string): number | null {
  if (raw === "off" || raw === "none" || raw === "null") return null;
  const cleaned = raw.replace(/^\$/, "").trim().toLowerCase();
  const match = cleaned.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!match) {
    throw new Error(`Could not parse ${metric} value: ${raw}`);
  }
  let amount = Number(match[1]);
  const suffix = match[2];
  if (suffix === "k") amount *= 1000;
  if (suffix === "m") amount *= 1_000_000;
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Could not parse ${metric} value: ${raw}`);
  }
  return amount;
}

function windowLabel(window: WindowName): string {
  return window === "rollingHour" ? "hourly" : "daily";
}

function formatMetric(metric: Metric, value: number | null): string {
  if (value == null) return "off";
  return metric === "usd" ? formatUsd(value) : formatTokens(value);
}

export function formatLimits(config: Config): string {
  const hour = config.limits.rollingHour;
  const day = config.limits.calendarDay;
  return [
    "Budget limits (estimated, not Cursor billed spend)",
    `  Hour (rolling 60m)  usd ${formatMetric("usd", hour.usd)}  tokens ${formatMetric("tokens", hour.tokens)}`,
    `  Day (local midnight) usd ${formatMetric("usd", day.usd)}  tokens ${formatMetric("tokens", day.tokens)}`,
    "",
  ].join("\n");
}
