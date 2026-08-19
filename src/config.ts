import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as v from "valibot";
import { budgetDir, configPath } from "./paths.js";

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

const finiteNumber = v.pipe(v.number(), v.finite());
const nonNegativeFinite = v.pipe(v.number(), v.finite(), v.minValue(0));

const LimitSchema = v.strictObject({
  usd: v.nullable(nonNegativeFinite),
  tokens: v.nullable(nonNegativeFinite),
});

const ModelRateSchema = v.strictObject({
  inputPerMillion: nonNegativeFinite,
  outputPerMillion: nonNegativeFinite,
  reasoningPerMillion: v.optional(nonNegativeFinite),
});

const ConfigFileSchema = v.strictObject({
  limits: v.optional(
    v.strictObject({
      rollingHour: v.optional(LimitSchema),
      calendarDay: v.optional(LimitSchema),
    }),
  ),
  accounting: v.optional(
    v.strictObject({
      provider: v.optional(v.literal("local")),
      safetyMultiplier: v.optional(v.pipe(finiteNumber, v.minValue(0))),
    }),
  ),
  warnings: v.optional(v.array(v.pipe(finiteNumber, v.minValue(0), v.maxValue(1)))),
  unknownModel: v.optional(v.picklist(["fallback", "block"] as const)),
  enforcement: v.optional(
    v.strictObject({
      failClosed: v.optional(v.boolean()),
    }),
  ),
  models: v.optional(v.record(v.string(), ModelRateSchema)),
  fallback: v.optional(ModelRateSchema),
  excludeConversationIds: v.optional(v.array(v.string())),
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function parseConfig(raw: unknown): Config {
  let parsed: v.InferOutput<typeof ConfigFileSchema>;
  try {
    parsed = v.parse(ConfigFileSchema, raw);
  } catch (error) {
    if (error instanceof v.ValiError) {
      throw new ConfigError(`Invalid config.json:\n${v.summarize(error.issues)}`);
    }
    throw error;
  }

  return {
    limits: {
      rollingHour: {
        ...DEFAULT_CONFIG.limits.rollingHour,
        ...parsed.limits?.rollingHour,
      },
      calendarDay: {
        ...DEFAULT_CONFIG.limits.calendarDay,
        ...parsed.limits?.calendarDay,
      },
    },
    accounting: {
      provider: "local",
      safetyMultiplier:
        parsed.accounting?.safetyMultiplier ?? DEFAULT_CONFIG.accounting.safetyMultiplier,
    },
    warnings: parsed.warnings ?? DEFAULT_CONFIG.warnings,
    unknownModel: parsed.unknownModel ?? DEFAULT_CONFIG.unknownModel,
    enforcement: {
      failClosed: parsed.enforcement?.failClosed ?? DEFAULT_CONFIG.enforcement.failClosed,
    },
    models: {
      ...DEFAULT_CONFIG.models,
      ...(parsed.models ?? {}),
    },
    fallback: {
      ...DEFAULT_CONFIG.fallback,
      ...parsed.fallback,
    },
    excludeConversationIds: parsed.excludeConversationIds ?? [],
  };
}

export function ensureConfig(home?: string): Config {
  const path = configPath(home);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(budgetDir(home), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    return structuredClone(DEFAULT_CONFIG);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Invalid config.json (not JSON): ${detail}`);
  }
  return parseConfig(raw);
}

export function writeConfig(config: Config, home?: string): void {
  const path = configPath(home);
  mkdirSync(dirname(path), { recursive: true });
  // Round-trip through the schema so we never write unknown or invalid fields.
  const validated = parseConfig(config);
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`);
}
