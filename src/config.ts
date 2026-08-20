import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as v from "valibot";
import { budgetDir, configPath } from "./paths.js";

export interface QuotaConfig {
  /**
   * Block when dashboard "Cursor Models" meter (`autoPercentUsed`) reaches this value.
   * Scale is **0–100** (same as the API), not 0–1. Distinct from `warnings`.
   */
  cursorModelsBlockAtPercent: number;
  /**
   * Block when dashboard "Other Models" meter (`apiPercentUsed`) reaches this value.
   * Scale is **0–100** (same as the API), not 0–1.
   */
  otherModelsBlockAtPercent: number;
  /**
   * Optional block on `totalPercentUsed` (**0–100**). `null` disables.
   */
  totalBlockAtPercent: number | null;
  /** Beyond this age, a stale-cache snapshot is treated as unknown usage. */
  maxStaleMs: number;
  /** Soft TTL for the SQLite usage cache before a network refresh is attempted. */
  cacheTtlMs: number;
}

export interface RateLimitConfig {
  /**
   * Rolling-hour event-count backstop. `null` disables.
   *
   * This is a runaway-loop catch, not a budget: the quota gate above is the
   * real limit. The default sits well above observed heavy use (peak measured
   * at 129 events/h) so normal agent work never trips it, while still capping
   * a stuck loop that could otherwise burn a lot inside one cache window.
   */
  maxEventsPerHour: number | null;
}

export interface Config {
  quota: QuotaConfig;
  rateLimit: RateLimitConfig;
  /**
   * Warning fractions of each quota block threshold (**0–1** scale).
   * e.g. `0.5` with `cursorModelsBlockAtPercent: 90` warns at 45% API usage.
   */
  warnings: number[];
  enforcement: {
    /**
     * When usage cannot be determined (auth expired, API down, snapshot older
     * than `maxStaleMs`), block instead of allowing. Default `true`: a guard
     * that silently stops guarding is worse than one that gets in the way.
     * Escape hatches stay open — `override`, `except add`, and every read-only
     * CLI command keep working while the gate is closed.
     */
    failClosed: boolean;
  };
  excludeConversationIds: string[];
}

export const DEFAULT_CONFIG: Config = {
  quota: {
    cursorModelsBlockAtPercent: 90,
    otherModelsBlockAtPercent: 90,
    totalBlockAtPercent: null,
    maxStaleMs: 3_600_000,
    cacheTtlMs: 90_000,
  },
  rateLimit: {
    maxEventsPerHour: 500,
  },
  warnings: [0.5, 0.75, 0.9],
  enforcement: {
    failClosed: true,
  },
  excludeConversationIds: [],
};

const finiteNumber = v.pipe(v.number(), v.finite());
const nonNegativeFinite = v.pipe(v.number(), v.finite(), v.minValue(0));
/** API / block thresholds: 0–100 percent of Cursor's quota meter. */
const percent0to100 = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100));
/** Warning fractions of the configured block threshold (0–1). */
const warningFraction = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1));

const QuotaSchema = v.strictObject({
  cursorModelsBlockAtPercent: v.optional(percent0to100),
  otherModelsBlockAtPercent: v.optional(percent0to100),
  totalBlockAtPercent: v.optional(v.nullable(percent0to100)),
  maxStaleMs: v.optional(nonNegativeFinite),
  cacheTtlMs: v.optional(nonNegativeFinite),
});

const RateLimitSchema = v.strictObject({
  maxEventsPerHour: v.optional(v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0)))),
});

const ConfigFileSchema = v.strictObject({
  // Common hand-edit annotations; ignored at runtime.
  $schema: v.optional(v.string()),
  _comment: v.optional(v.string()),
  quota: v.optional(QuotaSchema),
  rateLimit: v.optional(RateLimitSchema),
  warnings: v.optional(v.array(warningFraction)),
  enforcement: v.optional(
    v.strictObject({
      failClosed: v.optional(v.boolean()),
    }),
  ),
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
    quota: {
      cursorModelsBlockAtPercent:
        parsed.quota?.cursorModelsBlockAtPercent ?? DEFAULT_CONFIG.quota.cursorModelsBlockAtPercent,
      otherModelsBlockAtPercent:
        parsed.quota?.otherModelsBlockAtPercent ?? DEFAULT_CONFIG.quota.otherModelsBlockAtPercent,
      totalBlockAtPercent:
        parsed.quota?.totalBlockAtPercent === undefined
          ? DEFAULT_CONFIG.quota.totalBlockAtPercent
          : parsed.quota.totalBlockAtPercent,
      maxStaleMs: parsed.quota?.maxStaleMs ?? DEFAULT_CONFIG.quota.maxStaleMs,
      cacheTtlMs: parsed.quota?.cacheTtlMs ?? DEFAULT_CONFIG.quota.cacheTtlMs,
    },
    rateLimit: {
      maxEventsPerHour:
        parsed.rateLimit?.maxEventsPerHour === undefined
          ? DEFAULT_CONFIG.rateLimit.maxEventsPerHour
          : parsed.rateLimit.maxEventsPerHour,
    },
    warnings: parsed.warnings ?? DEFAULT_CONFIG.warnings,
    enforcement: {
      failClosed: parsed.enforcement?.failClosed ?? DEFAULT_CONFIG.enforcement.failClosed,
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

/** Persist only overrides so defaults stay code-owned. */
export function serializeConfig(config: Config): Record<string, unknown> {
  const validated = parseConfig(config);
  const file: Record<string, unknown> = {};

  const quota: Record<string, unknown> = {};
  for (const key of [
    "cursorModelsBlockAtPercent",
    "otherModelsBlockAtPercent",
    "totalBlockAtPercent",
    "maxStaleMs",
    "cacheTtlMs",
  ] as const) {
    if (validated.quota[key] !== DEFAULT_CONFIG.quota[key]) {
      quota[key] = validated.quota[key];
    }
  }
  if (Object.keys(quota).length > 0) {
    file.quota = quota;
  }

  if (validated.rateLimit.maxEventsPerHour !== DEFAULT_CONFIG.rateLimit.maxEventsPerHour) {
    file.rateLimit = { maxEventsPerHour: validated.rateLimit.maxEventsPerHour };
  }

  if (JSON.stringify(validated.warnings) !== JSON.stringify(DEFAULT_CONFIG.warnings)) {
    file.warnings = validated.warnings;
  }

  if (validated.enforcement.failClosed !== DEFAULT_CONFIG.enforcement.failClosed) {
    file.enforcement = { failClosed: validated.enforcement.failClosed };
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
