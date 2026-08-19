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

/** Partial limits: either key may be omitted when hand-editing. */
const LimitSchema = v.strictObject({
  usd: v.optional(v.nullable(nonNegativeFinite)),
  tokens: v.optional(v.nullable(nonNegativeFinite)),
});

/** Full rates for entries under `models` — a half-defined rate is wrong. */
const ModelRateSchema = v.strictObject({
  inputPerMillion: nonNegativeFinite,
  outputPerMillion: nonNegativeFinite,
  reasoningPerMillion: v.optional(nonNegativeFinite),
});

/** Partial rates for `fallback`, which merges onto defaults. */
const PartialModelRateSchema = v.strictObject({
  inputPerMillion: v.optional(nonNegativeFinite),
  outputPerMillion: v.optional(nonNegativeFinite),
  reasoningPerMillion: v.optional(nonNegativeFinite),
});

const ConfigFileSchema = v.strictObject({
  // Common hand-edit annotations; ignored at runtime.
  $schema: v.optional(v.string()),
  _comment: v.optional(v.string()),
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
  fallback: v.optional(PartialModelRateSchema),
  excludeConversationIds: v.optional(v.array(v.string())),
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function withConfigPath(path: string, detail: string): ConfigError {
  return new ConfigError(
    `${detail}\nConfig file: ${path}\nDelete this file to regenerate defaults.`,
  );
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
    // Keep the on-disk file minimal; defaults live in code.
    writeFileSync(path, "{}\n");
    return structuredClone(DEFAULT_CONFIG);
  }
  const text = readFileSync(path, "utf8");
  if (!text.trim()) {
    return parseConfig({});
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw withConfigPath(path, `Invalid config.json (not JSON): ${detail}`);
  }
  try {
    return parseConfig(raw);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw withConfigPath(path, error.message);
    }
    throw error;
  }
}

/** For read-only CLI commands: never brick recovery on a bad file. */
export function loadConfigForRead(home?: string): { config: Config; warning?: string } {
  try {
    return { config: ensureConfig(home) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      config: structuredClone(DEFAULT_CONFIG),
      warning: `Warning: using defaults because config failed to load.\n${detail}`,
    };
  }
}

function sameRate(a: ModelRate, b: ModelRate): boolean {
  return (
    a.inputPerMillion === b.inputPerMillion &&
    a.outputPerMillion === b.outputPerMillion &&
    (a.reasoningPerMillion ?? undefined) === (b.reasoningPerMillion ?? undefined)
  );
}

function serializeLimit(limit: Limit, defaults: Limit): Partial<Limit> | undefined {
  const out: Partial<Limit> = {};
  if (limit.usd !== defaults.usd) out.usd = limit.usd;
  if (limit.tokens !== defaults.tokens) out.tokens = limit.tokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Persist only overrides so default model rates stay code-owned. */
export function serializeConfig(config: Config): Record<string, unknown> {
  const validated = parseConfig(config);
  const file: Record<string, unknown> = {};

  const rollingHour = serializeLimit(
    validated.limits.rollingHour,
    DEFAULT_CONFIG.limits.rollingHour,
  );
  const calendarDay = serializeLimit(
    validated.limits.calendarDay,
    DEFAULT_CONFIG.limits.calendarDay,
  );
  if (rollingHour || calendarDay) {
    file.limits = {
      ...(rollingHour ? { rollingHour } : {}),
      ...(calendarDay ? { calendarDay } : {}),
    };
  }

  if (
    validated.accounting.safetyMultiplier !== DEFAULT_CONFIG.accounting.safetyMultiplier
  ) {
    file.accounting = {
      provider: "local",
      safetyMultiplier: validated.accounting.safetyMultiplier,
    };
  }

  if (JSON.stringify(validated.warnings) !== JSON.stringify(DEFAULT_CONFIG.warnings)) {
    file.warnings = validated.warnings;
  }

  if (validated.unknownModel !== DEFAULT_CONFIG.unknownModel) {
    file.unknownModel = validated.unknownModel;
  }

  if (validated.enforcement.failClosed !== DEFAULT_CONFIG.enforcement.failClosed) {
    file.enforcement = { failClosed: validated.enforcement.failClosed };
  }

  const models: Record<string, ModelRate> = {};
  for (const [pattern, rate] of Object.entries(validated.models)) {
    const baseline = DEFAULT_CONFIG.models[pattern];
    if (!baseline || !sameRate(rate, baseline)) {
      models[pattern] = rate;
    }
  }
  if (Object.keys(models).length > 0) {
    file.models = models;
  }

  if (!sameRate(validated.fallback, DEFAULT_CONFIG.fallback)) {
    file.fallback = validated.fallback;
  }

  if (validated.excludeConversationIds.length > 0) {
    file.excludeConversationIds = validated.excludeConversationIds;
  }

  return file;
}

export function writeConfig(config: Config, home?: string): void {
  const path = configPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(serializeConfig(config), null, 2)}\n`);
}
