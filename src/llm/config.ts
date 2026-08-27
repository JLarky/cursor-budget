import * as v from "valibot";
import { ConfigFileSchema } from "../config-schema.js";
import type { JsonValue } from "../json-value.js";

/**
 * Percent-only configuration: every gate compares a provider-reported
 * percentage against a threshold. There are no token or dollar amounts —
 * the providers own their limits; we only enforce thresholds.
 */

export interface ClaudeCodeConfig {
  enabled: boolean;
  /** Block at this % of Claude's weekly limit (vendor `weekly` window). */
  weeklyBlockAtPercent: number;
  /** Block at this % of Claude's 5h limit (vendor `five_hour` window). */
  rolling5hBlockAtPercent: number;
}

export interface CodexConfig {
  enabled: boolean;
  /** Block at this % of OpenAI's reported weekly limit. */
  weeklyBlockAtPercent: number;
  /**
   * Optional override of the Codex threshold; kept so an explicit
   * `openAiWeeklyBlockAtPercent` in config.jsonc always wins.
   */
  openAiWeeklyBlockAtPercent: number | null;
}

export interface LlmConfig {
  claudeCode: ClaudeCodeConfig;
  codex: CodexConfig;
  enforcement: {
    /**
     * When usage cannot be determined (API unreachable, window missing),
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

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

/** Parse + validate a raw config file object into a fully-resolved config. */
export function parseLlmConfig(raw: JsonValue | LlmConfig): LlmConfig {
  let parsed: v.InferOutput<typeof ConfigFileSchema>;
  try {
    parsed = v.parse(ConfigFileSchema, raw);
  } catch (error) {
    if (error instanceof v.ValiError) {
      throw new LlmConfigError(`Invalid config.jsonc:\n${v.summarize(error.issues)}`);
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


/**
 * Render Claude Code / Codex fields for unit tests. Disk writes use
 * `renderUnifiedConfigFile` so Cursor Agent keys in the shared file survive.
 */
export function renderLlmConfigFile(c: LlmConfig): string {
  const pct = (v: number) => `${v}`;
  return `// llm-budget configuration \u2014 JSONC, so comments and trailing commas are fine.
// Every field is listed with its current value; delete nothing you do not
// understand \u2014 removing a field just falls back to the noted default.
//
// Percentages come from the vendor usage APIs (Anthropic OAuth for Claude Code,
// OpenAI rate-limit telemetry for Codex); each gate blocks once usage reaches
// its threshold.
{
  "claudeCode": {
    // Gate Claude Code sessions at all?
    "enabled": ${c.claudeCode.enabled},
    // Block at this % of Claude's weekly limit (window "weekly").
    "weeklyBlockAtPercent": ${pct(c.claudeCode.weeklyBlockAtPercent)},
    // Block at this % of Claude's 5-hour limit (window "five_hour").
    "rolling5hBlockAtPercent": ${pct(c.claudeCode.rolling5hBlockAtPercent)}
  },
  "codex": {
    // Gate Codex CLI sessions?
    "enabled": ${c.codex.enabled},
    // Block at this % of OpenAI's reported weekly limit.
    "weeklyBlockAtPercent": ${pct(c.codex.weeklyBlockAtPercent)},
    // Optional override of the Codex threshold; null uses weeklyBlockAtPercent.
    "openAiWeeklyBlockAtPercent": ${c.codex.openAiWeeklyBlockAtPercent === null ? "null" : pct(c.codex.openAiWeeklyBlockAtPercent)}
  },
  "enforcement": {
    // When usage cannot be determined (API down), block instead of allow.
    "failClosed": ${c.enforcement.failClosed}
  },
  // Session ids that bypass every gate.
  "excludeSessionIds": [${c.excludeSessionIds.map((id) => JSON.stringify(id)).join(", ")}]
}
`;
}

export { ensureLlmConfig, formatSharedConfigFile, loadLlmConfigForRead, writeLlmConfig } from "../unified-config.js";
