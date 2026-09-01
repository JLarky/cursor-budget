import { homedir } from "node:os";
import { join } from "node:path";
import { configPath, dataDir, dbPath } from "../paths.js";

export function llmBudgetDir(home = homedir()): string {
  return dataDir(home);
}

export function llmConfigPath(home = homedir()): string {
  return configPath(home);
}

export function llmDbPath(home = homedir()): string {
  return dbPath(home);
}

export function claudeSettingsPath(home = homedir()): string {
  return join(home, ".claude", "settings.json");
}

export function claudeHookWrapperPath(home = homedir()): string {
  return join(dataDir(home), "bin", "claude-hook");
}

export function codexHooksPath(home = homedir()): string {
  return join(home, ".codex", "hooks.json");
}

export function codexHookWrapperPath(home = homedir()): string {
  return join(dataDir(home), "bin", "codex-hook");
}

export function codexHookStatePath(home = homedir()): string {
  return join(dataDir(home), "codex-hooks-state.json");
}

/** `GROK_HOME` overrides the whole directory, not just the leaf under `home`. */
export function grokHome(home = homedir()): string {
  return process.env.GROK_HOME || join(home, ".grok");
}

export function grokHooksFilePath(home = homedir()): string {
  return join(grokHome(home), "hooks", "llm-budget.json");
}

export function grokHookWrapperPath(home = homedir()): string {
  return join(dataDir(home), "bin", "grok-hook");
}

export function grokAuthPath(home = homedir()): string {
  return join(grokHome(home), "auth.json");
}

export function grokAuthLockPath(home = homedir()): string {
  return join(grokHome(home), "auth.json.lock");
}
