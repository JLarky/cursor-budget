import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { budgetDir, configPath } from "./paths.js";

export type Precision = "exact" | "estimated" | "observable";

export interface Limit {
  usd: number | null;
  tokens: number | null;
}

export interface ModelRate {
  inputPerMillion: number;
  outputPerMillion: number;
  reasoningPerMillion?: number;
}

export interface Config {
  limits: {
    rollingHour: Limit;
    calendarDay: Limit;
  };
  accounting: {
    provider: "local";
    safetyMultiplier: number;
  };
  warnings: number[];
  unknownModel: "fallback" | "block";
  enforcement: {
    failClosed: boolean;
  };
  models: Record<string, ModelRate>;
  fallback: ModelRate;
  excludeConversationIds: string[];
}

export const DEFAULT_CONFIG: Config = {
  limits: {
    rollingHour: { usd: null, tokens: null },
    calendarDay: { usd: null, tokens: null },
  },
  accounting: {
    provider: "local",
    safetyMultiplier: 2.0,
  },
  warnings: [0.5, 0.75, 0.9],
  unknownModel: "fallback",
  enforcement: {
    failClosed: false,
  },
  models: {
    "claude-sonnet-*": { inputPerMillion: 3, outputPerMillion: 15 },
    "claude-opus-*": { inputPerMillion: 15, outputPerMillion: 75 },
    "gpt-*": { inputPerMillion: 5, outputPerMillion: 15 },
    "composer-*": { inputPerMillion: 3, outputPerMillion: 15 },
    "grok-*": { inputPerMillion: 3, outputPerMillion: 15 },
  },
  fallback: {
    inputPerMillion: 15,
    outputPerMillion: 75,
  },
  excludeConversationIds: [],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeLimit(base: Limit, raw: unknown): Limit {
  if (!isObject(raw)) return base;
  return {
    usd: raw.usd === undefined ? base.usd : (raw.usd as number | null),
    tokens: raw.tokens === undefined ? base.tokens : (raw.tokens as number | null),
  };
}

export function parseConfig(raw: unknown): Config {
  const src = isObject(raw) ? raw : {};
  const limits = isObject(src.limits) ? src.limits : {};
  const accounting = isObject(src.accounting) ? src.accounting : {};
  const enforcement = isObject(src.enforcement) ? src.enforcement : {};
  return {
    limits: {
      rollingHour: mergeLimit(DEFAULT_CONFIG.limits.rollingHour, limits.rollingHour),
      calendarDay: mergeLimit(DEFAULT_CONFIG.limits.calendarDay, limits.calendarDay),
    },
    accounting: {
      provider: "local",
      safetyMultiplier:
        typeof accounting.safetyMultiplier === "number"
          ? accounting.safetyMultiplier
          : DEFAULT_CONFIG.accounting.safetyMultiplier,
    },
    warnings: Array.isArray(src.warnings)
      ? src.warnings.filter((n): n is number => typeof n === "number")
      : DEFAULT_CONFIG.warnings,
    unknownModel: src.unknownModel === "block" ? "block" : "fallback",
    enforcement: {
      failClosed: enforcement.failClosed === true,
    },
    models: isObject(src.models)
      ? (src.models as Config["models"])
      : DEFAULT_CONFIG.models,
    fallback: isObject(src.fallback)
      ? { ...DEFAULT_CONFIG.fallback, ...(src.fallback as unknown as ModelRate) }
      : DEFAULT_CONFIG.fallback,
    excludeConversationIds: Array.isArray(src.excludeConversationIds)
      ? src.excludeConversationIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

export function ensureConfig(home?: string): Config {
  const path = configPath(home);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(budgetDir(home), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    return DEFAULT_CONFIG;
  }
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function writeConfig(config: Config, home?: string): void {
  const path = configPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
