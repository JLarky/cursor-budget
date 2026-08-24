import { homedir } from "node:os";
import { join } from "node:path";

/**
 * State root for the Claude Code / Codex guard.
 *
 * Deliberately separate from `~/.cursor/llm-budget`: the cursor config schema
 * is strict (unknown keys throw) so sharing one file would brick cursor
 * installs the moment an agent key appeared. Override and exception state are
 * per-tool on purpose too — unblocking Codex should not silently unblock
 * Cursor.
 */
export function llmBudgetDir(home = homedir()): string {
  return join(home, ".llm-budget");
}

export function llmConfigPath(home = homedir()): string {
  return join(llmBudgetDir(home), "config.json");
}

/** Optional rate table (`import-rates` writes it; hand-editing works too). */
export function ratesPath(home = homedir()): string {
  return join(llmBudgetDir(home), "rates.json");
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

export function claudeTranscriptRoots(home = homedir()): string[] {
  return [join(home, ".claude", "projects")];
}

export function codexTranscriptRoots(home = homedir()): string[] {
  return [join(home, ".codex", "sessions"), join(home, ".codex", "archived_sessions")];
}
