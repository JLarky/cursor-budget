import { homedir } from "node:os";
import { join } from "node:path";

/** XDG config dir: `~/.config/llm-budget`. */
export function configDir(home = homedir()): string {
  return join(home, ".config", "llm-budget");
}

/** SQLite and hook wrappers. */
export function dataDir(home = homedir()): string {
  return join(home, ".local", "share", "llm-budget");
}

/** Cursor Agent CLI session file (`accessToken` / `refreshToken`). */
export function cliAuthPath(home = homedir()): string {
  return join(home, ".config", "cursor", "auth.json");
}

export function configPath(home = homedir()): string {
  return join(configDir(home), "config.jsonc");
}

export function dbPath(home = homedir()): string {
  return join(dataDir(home), "usage.sqlite3");
}

export function hooksJsonPath(home = homedir()): string {
  return join(home, ".cursor", "hooks.json");
}

export function hookWrapperPath(home = homedir()): string {
  return join(home, ".cursor", "hooks", "llm-budget");
}
