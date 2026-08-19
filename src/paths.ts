import { homedir } from "node:os";
import { join } from "node:path";

export function budgetDir(home = homedir()): string {
  return join(home, ".cursor", "llm-budget");
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
  return join(home, ".cursor", "hooks", "cursor-budget");
}
