import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import * as v from "valibot";
import { llmConfigPath } from "./paths.js";

/**
 * Percent-only configuration: every gate compares a provider-reported
 * percentage against a threshold. There are no token or dollar amounts —
 * the providers (via Paseo) own their limits; we only enforce thresholds.
 */

export interface ClaudeCodeConfig {
  enabled: boolean;
  /** Block at this % of Claude's weekly limit (Paseo `seven_day` window). */
  weeklyBlockAtPercent: number;
  /** Block at this % of Claude's 5h limit (Paseo `five_hour` window). */
  rolling5hBlockAtPercent: number;
}

export interface CodexConfig {
  enabled: boolean;
  /** Block at this % of OpenAI's reported weekly limit. */
  weeklyBlockAtPercent: number;
  /**
   * Optional override of the Codex threshold; kept so an explicit
   * `openAiWeeklyBlockAtPercent` in config.json always wins.
   */
  openAiWeeklyBlockAtPercent: number | null;
}

export interface LlmConfig {
  claudeCode: ClaudeCodeConfig;
  codex: CodexConfig;
  enforcement: {
    /**
     * When usage cannot be determined (Paseo unreachable, window missing),
     * block instead of allowing. Escape hatches stay open.
     */
    failClosed: boolean;
  };
  excludeSessionIds: string[];
}

export const DEFAULT_CONFIG: LlmConfig = {
  claudeCode: {
    enabled: true,
    weeklyBlockAtPercent: 80,
    rolling5hBlockAtPercent: 80,
  },
  codex: {
    enabled: true,
    weeklyBlockAtPercent: 80,
    openAiWeeklyBlockAtPercent: null,
  },
  enforcement: {
    failClosed: true,
  },
  excludeSessionIds: [],
};

const percent0to100 = v.pipe(v.number(), v.minValue(0), v.maxValue(100));

const ClaudeCodeSchema = v.strictObject({
  enabled: v.optional(v.boolean()),
  weeklyBlockAtPercent: v.optional(percent0to100),
  rolling5hBlockAtPercent: v.optional(percent0to100),
});

const CodexSchema = v.strictObject({
  enabled: v.optional(v.boolean()),
  weeklyBlockAtPercent: v.optional(percent0to100),
  // Null means "fall back to weeklyBlockAtPercent".
  openAiWeeklyBlockAtPercent: v.optional(v.nullable(percent0to100)),
});

const ConfigFileSchema = v.strictObject({
  $schema: v.optional(v.string()),
  _comment: v.optional(v.string()),
  claudeCode: v.optional(ClaudeCodeSchema),
  codex: v.optional(CodexSchema),
  enforcement: v.optional(
    v.strictObject({ failClosed: v.optional(v.boolean()) }),
  ),
  excludeSessionIds: v.optional(v.array(v.pipe(v.string(), v.trim(), v.minLength(1)))),
});

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

/** Parse + validate a raw config file object into a fully-resolved config. */
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
    claudeCode: {
      enabled: parsed.claudeCode?.enabled ?? DEFAULT_CONFIG.claudeCode.enabled,
      weeklyBlockAtPercent:
        parsed.claudeCode?.weeklyBlockAtPercent ??
        DEFAULT_CONFIG.claudeCode.weeklyBlockAtPercent,
      rolling5hBlockAtPercent:
        parsed.claudeCode?.rolling5hBlockAtPercent ??
        DEFAULT_CONFIG.claudeCode.rolling5hBlockAtPercent,
    },
    codex: {
      enabled: parsed.codex?.enabled ?? DEFAULT_CONFIG.codex.enabled,
      weeklyBlockAtPercent:
        parsed.codex?.weeklyBlockAtPercent ?? DEFAULT_CONFIG.codex.weeklyBlockAtPercent,
      openAiWeeklyBlockAtPercent:
        parsed.codex?.openAiWeeklyBlockAtPercent === undefined
          ? null
          : (parsed.codex.openAiWeeklyBlockAtPercent ?? null),
    },
    enforcement: {
      failClosed: parsed.enforcement?.failClosed ?? DEFAULT_CONFIG.enforcement.failClosed,
    },
    excludeSessionIds: parsed.excludeSessionIds ?? [],
  };
}

function loadRawConfig(home?: string): unknown {
  const path = llmConfigPath(home);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LlmConfigError(`Cannot read ${path}: ${detail}`);
  }
}

/** Lenient read: falls back to defaults when the file is missing or broken. */
export function loadLlmConfigForRead(home?: string): {
  config: LlmConfig;
  warning: string | null;
} {
  try {
    return { config: parseLlmConfig(loadRawConfig(home)), warning: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      config: structuredClone(DEFAULT_CONFIG),
      warning: `Warning: ${detail}\nWarning: using default percent gates until config.json is fixed\n`,
    };
  }
}

/** Strict read: throws on a missing/broken file. For enforcing paths. */
export function ensureLlmConfig(home?: string): LlmConfig {
  const path = llmConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    // Keep the on-disk file minimal; defaults live in code.
    writeFileSync(path, "{}\n");
  }
  return parseLlmConfig(loadRawConfig(home));
}

/** Persist a fully-resolved config in minimal override form. */
export function writeLlmConfig(config: LlmConfig, home?: string): void {
  const path = llmConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(serializeLlmConfig(config), null, 2)}\n`);
}

/**
 * Serialize back to the minimal on-disk form: only values that differ from
 * defaults are written, so the file stays hand-editable and future defaults
 * can improve silently.
 */
export function serializeLlmConfig(validated: LlmConfig): unknown {
  const file: Record<string, unknown> = {};

  const claudeOverrides: Record<string, unknown> = {};
  for (const key of ["enabled", "weeklyBlockAtPercent", "rolling5hBlockAtPercent"] as const) {
    if (validated.claudeCode[key] !== DEFAULT_CONFIG.claudeCode[key]) {
      claudeOverrides[key] = validated.claudeCode[key];
    }
  }
  if (Object.keys(claudeOverrides).length > 0) {
    file.claudeCode = claudeOverrides;
  }

  const codexOverrides: Record<string, unknown> = {};
  for (const key of ["enabled", "weeklyBlockAtPercent", "openAiWeeklyBlockAtPercent"] as const) {
    if (validated.codex[key] !== DEFAULT_CONFIG.codex[key]) {
      codexOverrides[key] = validated.codex[key];
    }
  }
  if (Object.keys(codexOverrides).length > 0) {
    file.codex = codexOverrides;
  }

  if (validated.enforcement.failClosed !== DEFAULT_CONFIG.enforcement.failClosed) {
    file.enforcement = { failClosed: validated.enforcement.failClosed };
  }

  if (validated.excludeSessionIds.length > 0) {
    file.excludeSessionIds = validated.excludeSessionIds;
  }

  return file;
}
