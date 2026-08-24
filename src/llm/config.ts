import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as v from "valibot";
import { llmBudgetDir, llmConfigPath, ratesPath } from "./paths.js";

/**
 * What "100%" means. Explicit in config on purpose: a percent against an
 * undefined denominator is decoration. Tokens count every billed bucket
 * (input + output + reasoning + cache read + cache write) exactly like the
 * prior art's `Counters.total`; USD prices those same buckets with per-model
 * rates.
 */
export type DenominatorConfig =
  | { kind: "tokens"; weeklyTokens: number }
  | { kind: "usd"; weeklyUsd: number };

/** $/1M tokens. `reasoning` defaults to `output`, cache fields to 0. */
export interface ModelRate {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

export type RateTable = Record<string, ModelRate>;

export interface ClaudeCodeConfig {
  enabled: boolean;
  /** Block at this % of the budget denominator over the pinned UTC week. */
  weeklyBlockAtPercent: number;
  /** Block at this % of the budget denominator inside the rolling window. */
  rolling5hBlockAtPercent: number;
  /** Rolling window length; default mirrors Claude's 5-hour session window. */
  rollingWindowMs: number;
}

export interface CodexConfig {
  enabled: boolean;
  /** Block at this % of the budget denominator over the pinned UTC week. */
  weeklyBlockAtPercent: number;
}

export interface LlmConfig {
  budget: {
    denominator: DenominatorConfig;
    /** Inline rate overrides; merged over rates.json. */
    rates?: RateTable;
  };
  claudeCode: ClaudeCodeConfig;
  codex: CodexConfig;
  /** Fractions (0-1) of each block threshold that fire desktop warnings. */
  warnings: number[];
  enforcement: {
    /**
     * When usage cannot be determined (unreadable transcripts, broken db),
     * block instead of allowing. Escape hatches stay open.
     */
    failClosed: boolean;
  };
  /** Sessions that bypass every gate (mirrors cursor-budget's except list). */
  excludeSessionIds: string[];
}

export const DEFAULT_ROLLING_WINDOW_MS = 5 * 3_600_000;

export const DEFAULT_CONFIG: LlmConfig = {
  budget: {
    // Placeholder denominator — README asks every user to set their own.
    denominator: { kind: "tokens", weeklyTokens: 10_000_000 },
  },
  claudeCode: {
    enabled: true,
    weeklyBlockAtPercent: 80,
    rolling5hBlockAtPercent: 80,
    rollingWindowMs: DEFAULT_ROLLING_WINDOW_MS,
  },
  codex: {
    enabled: true,
    weeklyBlockAtPercent: 80,
  },
  warnings: [0.5, 0.75, 0.9],
  enforcement: {
    failClosed: true,
  },
  excludeSessionIds: [],
};

const finiteNumber = v.pipe(v.number(), v.finite());
const positiveNumber = v.pipe(v.number(), v.finite(), v.minValue(0), v.gtValue(0));
const nonNegativeFinite = v.pipe(v.number(), v.finite(), v.minValue(0));
/** Block thresholds: 0–100 percent of the configured denominator. */
const percent0to100 = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100));
const warningFraction = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1));

const DenominatorSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("tokens"), weeklyTokens: positiveNumber }),
  v.strictObject({ kind: v.literal("usd"), weeklyUsd: positiveNumber }),
]);

const ModelRateSchema = v.strictObject({
  input: finiteNumber,
  output: finiteNumber,
  cacheRead: v.optional(finiteNumber),
  cacheWrite: v.optional(finiteNumber),
  reasoning: v.optional(finiteNumber),
});

const BudgetSchema = v.strictObject({
  denominator: DenominatorSchema,
  rates: v.optional(v.record(v.string(), ModelRateSchema)),
});

const ClaudeCodeSchema = v.strictObject({
  enabled: v.optional(v.boolean()),
  weeklyBlockAtPercent: v.optional(percent0to100),
  rolling5hBlockAtPercent: v.optional(percent0to100),
  rollingWindowMs: v.optional(nonNegativeFinite),
});

const CodexSchema = v.strictObject({
  enabled: v.optional(v.boolean()),
  weeklyBlockAtPercent: v.optional(percent0to100),
});

const ConfigFileSchema = v.strictObject({
  $schema: v.optional(v.string()),
  _comment: v.optional(v.string()),
  budget: v.optional(BudgetSchema),
  claudeCode: v.optional(ClaudeCodeSchema),
  codex: v.optional(CodexSchema),
  warnings: v.optional(v.array(warningFraction)),
  enforcement: v.optional(
    v.strictObject({
      failClosed: v.optional(v.boolean()),
    }),
  ),
  excludeSessionIds: v.optional(v.array(v.string())),
});

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

function withConfigPath(path: string, detail: string): LlmConfigError {
  return new LlmConfigError(
    `${detail}\nConfig file: ${path}\nDelete this file to regenerate defaults.`,
  );
}

export function parseLlmConfig(raw: unknown): LlmConfig {
  let parsed: v.InferOutput<typeof ConfigFileSchema>;
  try {
    parsed = v.parse(ConfigFileSchema, raw);
  } catch (error) {
    if (error instanceof v.ValiError) {
      throw new LlmConfigError(`Invalid config.json:\n${v.summarize(error.issues)}`);
    }
    throw error;
  }

  return {
    budget: {
      denominator: parsed.budget?.denominator ?? structuredClone(DEFAULT_CONFIG.budget.denominator),
      rates: parsed.budget?.rates,
    },
    claudeCode: {
      enabled: parsed.claudeCode?.enabled ?? DEFAULT_CONFIG.claudeCode.enabled,
      weeklyBlockAtPercent:
        parsed.claudeCode?.weeklyBlockAtPercent ??
        DEFAULT_CONFIG.claudeCode.weeklyBlockAtPercent,
      rolling5hBlockAtPercent:
        parsed.claudeCode?.rolling5hBlockAtPercent ??
        DEFAULT_CONFIG.claudeCode.rolling5hBlockAtPercent,
      rollingWindowMs:
        parsed.claudeCode?.rollingWindowMs ?? DEFAULT_CONFIG.claudeCode.rollingWindowMs,
    },
    codex: {
      enabled: parsed.codex?.enabled ?? DEFAULT_CONFIG.codex.enabled,
      weeklyBlockAtPercent:
        parsed.codex?.weeklyBlockAtPercent ?? DEFAULT_CONFIG.codex.weeklyBlockAtPercent,
    },
    warnings: parsed.warnings ?? DEFAULT_CONFIG.warnings,
    enforcement: {
      failClosed: parsed.enforcement?.failClosed ?? DEFAULT_CONFIG.enforcement.failClosed,
    },
    excludeSessionIds: parsed.excludeSessionIds ?? [],
  };
}

export function ensureLlmConfig(home?: string): LlmConfig {
  const path = llmConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(llmBudgetDir(home), { recursive: true });
  if (!existsSync(path)) {
    // Keep the on-disk file minimal; defaults live in code.
    writeFileSync(path, "{}\n");
    return structuredClone(DEFAULT_CONFIG);
  }
  const text = readFileSync(path, "utf8");
  if (!text.trim()) {
    return parseLlmConfig({});
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw withConfigPath(path, `Invalid config.json (not JSON): ${detail}`);
  }
  try {
    return parseLlmConfig(raw);
  } catch (error) {
    if (error instanceof LlmConfigError) {
      throw withConfigPath(path, error.message);
    }
    throw error;
  }
}

/** For read-only CLI commands: never brick recovery on a bad file. */
export function loadLlmConfigForRead(home?: string): { config: LlmConfig; warning?: string } {
  try {
    return { config: ensureLlmConfig(home) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      config: structuredClone(DEFAULT_CONFIG),
      warning: `Warning: using defaults because config failed to load.\n${detail}`,
    };
  }
}

/** Persist only overrides so defaults stay code-owned. */
export function serializeLlmConfig(config: LlmConfig): Record<string, unknown> {
  const validated = parseLlmConfig(config);
  const file: Record<string, unknown> = {};

  const defaultDenominator = DEFAULT_CONFIG.budget.denominator;
  if (
    validated.budget.denominator.kind !== defaultDenominator.kind ||
    !denominatorsEqual(validated.budget.denominator, defaultDenominator)
  ) {
    file.budget = { denominator: validated.budget.denominator };
  }
  if (validated.budget.rates && Object.keys(validated.budget.rates).length > 0) {
    file.budget ??= {};
    (file.budget as Record<string, unknown>).rates = validated.budget.rates;
  }

  const claudeOverrides: Record<string, unknown> = {};
  for (const key of [
    "enabled",
    "weeklyBlockAtPercent",
    "rolling5hBlockAtPercent",
    "rollingWindowMs",
  ] as const) {
    if (validated.claudeCode[key] !== DEFAULT_CONFIG.claudeCode[key]) {
      claudeOverrides[key] = validated.claudeCode[key];
    }
  }
  if (Object.keys(claudeOverrides).length > 0) {
    file.claudeCode = claudeOverrides;
  }

  const codexOverrides: Record<string, unknown> = {};
  for (const key of ["enabled", "weeklyBlockAtPercent"] as const) {
    if (validated.codex[key] !== DEFAULT_CONFIG.codex[key]) {
      codexOverrides[key] = validated.codex[key];
    }
  }
  if (Object.keys(codexOverrides).length > 0) {
    file.codex = codexOverrides;
  }

  if (JSON.stringify(validated.warnings) !== JSON.stringify(DEFAULT_CONFIG.warnings)) {
    file.warnings = validated.warnings;
  }

  if (validated.enforcement.failClosed !== DEFAULT_CONFIG.enforcement.failClosed) {
    file.enforcement = { failClosed: validated.enforcement.failClosed };
  }

  if (validated.excludeSessionIds.length > 0) {
    file.excludeSessionIds = validated.excludeSessionIds;
  }

  return file;
}

function denominatorsEqual(a: DenominatorConfig, b: DenominatorConfig): boolean {
  if (a.kind === "tokens" && b.kind === "tokens") return a.weeklyTokens === b.weeklyTokens;
  if (a.kind === "usd" && b.kind === "usd") return a.weeklyUsd === b.weeklyUsd;
  return false;
}

export function writeLlmConfig(config: LlmConfig, home?: string): void {
  const path = llmConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(serializeLlmConfig(config), null, 2)}\n`);
}
