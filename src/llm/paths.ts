import { homedir } from "node:os";
import { join } from "node:path";

/**
 * State root for Claude Code and Codex.
 *
 * Cursor Agent keeps dashboard state in `~/.cursor/llm-budget` because that
 * config schema is strict (unknown keys throw) — sharing one file would
 * brick one agent the moment the other's keys appeared. Override and
 * exception state are per-store on purpose too: unblocking one agent must
 * not silently unblock another.
 */
export function llmBudgetDir(home = homedir()): string {
  return join(home, ".llm-budget");
}

/** Primary config: JSONC (comments + trailing commas allowed). */
export function llmConfigPath(home = homedir()): string {
  return join(llmBudgetDir(home), "config.jsonc");
}



export function llmDbPath(home = homedir()): string {
  return join(llmBudgetDir(home), "usage.sqlite3");
}

export function claudeSettingsPath(home = homedir()): string {
  return join(home, ".claude", "settings.json");
}

export function claudeHookWrapperPath(home = homedir()): string {
  return join(llmBudgetDir(home), "bin", "claude-hook");
}

export function codexShimDir(home = homedir()): string {
  return join(llmBudgetDir(home), "bin");
}

/** Installed as a `codex` entrypoint; put this dir first on PATH. */
export function codexShimPath(home = homedir()): string {
  return join(codexShimDir(home), "codex");
}
