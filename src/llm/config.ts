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
   * `openAiWeeklyBlockAtPercent` in config.jsonc always wins.
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
 * Strip `//` line comments and `/* ... *` block comments from JSONC source.
 * String literals are copied verbatim so a "//" inside a value survives.
 */
export function stripJsoncComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === '"') break;
        else j++;
      }
      out += src.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*" + "/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Drop commas immediately before `}` or `]` (JSONC allows them). */
export function stripTrailingCommas(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === '"') break;
        else j++;
      }
      out += src.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === "}" || src[j] === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Parse JSONC text (comments and trailing commas tolerated). */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsoncComments(text)));
}

function loadRawConfig(home?: string): unknown {
  const path = llmConfigPath(home);
  if (!existsSync(path)) return {};
  try {
    return parseJsonc(readFileSync(path, "utf8"));
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
      warning: `Warning: ${detail}\nWarning: using default percent gates until config.jsonc is fixed\n`,
    };
  }
}

/**
 * Render a fully-documented config.jsonc. Every supported field appears with
 * an explanation and its effective value, so the file doubles as schema docs.
 */
export function renderLlmConfigFile(c: LlmConfig): string {
  const pct = (v: number) => `${v}`;
  return `// llm-budget configuration \u2014 JSONC, so comments and trailing commas are fine.
// Every field is listed with its current value; delete nothing you do not
// understand \u2014 removing a field just falls back to the noted default.
//
// Percentages come from the Paseo daemon (Anthropic/OpenAI report their own
// limits); each gate blocks once usage reaches its threshold.
{
  "claudeCode": {
    // Gate Claude Code sessions at all?
    "enabled": ${c.claudeCode.enabled},
    // Block at this % of Claude's weekly limit (Paseo window "weekly"/"seven_day").
    "weeklyBlockAtPercent": ${pct(c.claudeCode.weeklyBlockAtPercent)},
    // Block at this % of Claude's 5-hour limit (Paseo window "five_hour").
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
    // When usage cannot be determined (Paseo down), block instead of allow.
    "failClosed": ${c.enforcement.failClosed}
  },
  // Session ids that bypass every gate.
  "excludeSessionIds": [${c.excludeSessionIds.map((id) => JSON.stringify(id)).join(", ")}]
}
`;
}

/** Strict read: throws on a missing/broken file. For enforcing paths. */
export function ensureLlmConfig(home?: string): LlmConfig {
  const path = llmConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    // First run: give users a fully-documented starting point.
    writeFileSync(path, renderLlmConfigFile(DEFAULT_CONFIG));
    return DEFAULT_CONFIG;
  }
  return parseLlmConfig(loadRawConfig(home));
}

/** Persist a fully-resolved config in documented template form. */
export function writeLlmConfig(config: LlmConfig, home?: string): void {
  const path = llmConfigPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderLlmConfigFile(config));
}

