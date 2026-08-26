import type { Config } from "./config.js";
import type { LlmConfig } from "./llm/config.js";

/**
 * One documented config.jsonc for every agent. Cursor Agent settings live
 * under `cursor` so they can share `~/.config/llm-budget/config.jsonc` with Claude Code and Codex
 * without two writers clobbering each other.
 */
export function renderUnifiedConfigFile(llm: LlmConfig, cursor: Config): string {
  const pct = (n: number) => `${n}`;
  const warnings = cursor.warnings.map((w) => `${w}`).join(", ");
  const cursorExcept = cursor.excludeConversationIds.map((id) => JSON.stringify(id)).join(", ");
  const llmExcept = llm.excludeSessionIds.map((id) => JSON.stringify(id)).join(", ");
  const failClosed = llm.enforcement.failClosed;
  return `// llm-budget configuration — JSONC, so comments and trailing commas are fine.
// Every field is listed with its current value; delete a field to fall back
// to its noted default. Claude Code, Codex, and Cursor Agent share this file.
{
  "claudeCode": {
    // Gate Claude Code sessions at all?
    "enabled": ${llm.claudeCode.enabled},
    // Block at this % of Claude's weekly limit (window "weekly").
    "weeklyBlockAtPercent": ${pct(llm.claudeCode.weeklyBlockAtPercent)},
    // Block at this % of Claude's 5-hour limit (window "five_hour").
    "rolling5hBlockAtPercent": ${pct(llm.claudeCode.rolling5hBlockAtPercent)}
  },
  "codex": {
    // Gate Codex CLI sessions?
    "enabled": ${llm.codex.enabled},
    // Block at this % of OpenAI's reported weekly limit.
    "weeklyBlockAtPercent": ${pct(llm.codex.weeklyBlockAtPercent)},
    // Optional override of the Codex threshold; null uses weeklyBlockAtPercent.
    "openAiWeeklyBlockAtPercent": ${llm.codex.openAiWeeklyBlockAtPercent === null ? "null" : pct(llm.codex.openAiWeeklyBlockAtPercent)}
  },
  "cursor": {
    "quota": {
      // Block when the dashboard "Cursor Models" meter reaches this % (0-100).
      "cursorModelsBlockAtPercent": ${cursor.quota.cursorModelsBlockAtPercent},
      // Block when the dashboard "Other Models" meter reaches this % (0-100).
      "otherModelsBlockAtPercent": ${cursor.quota.otherModelsBlockAtPercent},
      // Optional block on the combined "total" meter; null disables.
      "totalBlockAtPercent": ${cursor.quota.totalBlockAtPercent === null ? "null" : cursor.quota.totalBlockAtPercent},
      // Beyond this age (ms) a cached snapshot is treated as unknown usage.
      "maxStaleMs": ${cursor.quota.maxStaleMs},
      // Soft TTL (ms) for the local snapshot cache before a network refresh.
      "cacheTtlMs": ${cursor.quota.cacheTtlMs}
    },
    "rateLimit": {
      // Runaway-loop backstop: max hook events per rolling hour; null disables.
      "maxEventsPerHour": ${cursor.rateLimit.maxEventsPerHour === null ? "null" : cursor.rateLimit.maxEventsPerHour}
    },
    // Warning fractions (0-1) of each Cursor quota block threshold.
    "warnings": [${warnings}],
    // Cursor Agent conversation ids that bypass every Cursor gate.
    "excludeConversationIds": [${cursorExcept}]
  },
  "enforcement": {
    // When usage cannot be determined (API down), block instead of allow.
    "failClosed": ${failClosed}
  },
  // Claude Code / Codex session ids that bypass those gates.
  "excludeSessionIds": [${llmExcept}]
}
`;
}
