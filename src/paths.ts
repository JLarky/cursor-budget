import { homedir } from "node:os";
import { join } from "node:path";

export function budgetDir(home = homedir()): string {
  return join(home, ".cursor", "llm-budget");
}

/** Cursor Agent CLI session file (`accessToken` / `refreshToken`). */
export function cliAuthPath(home = homedir()): string {
  return join(home, ".config", "cursor", "auth.json");
}

export function configPath(home = homedir()): string {
  return join(budgetDir(home), "config.json");
}

export function dbPath(home = homedir()): string {
  return join(budgetDir(home), "usage.sqlite3");
}

export function hooksJsonPath(home = homedir()): string {
  return join(home, ".cursor", "hooks.json");
}

export function hookWrapperPath(home = homedir()): string {
  return join(home, ".cursor", "hooks", "llm-budget");
}
