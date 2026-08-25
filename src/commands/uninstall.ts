import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { PERIOD_USAGE_CACHE_KEY } from "../accounting/cursor-api.js";
import { DEFAULT_CONFIG, writeConfig } from "../config.js";
import { openDb, setCursorOverride, setState } from "../db/client.js";
import { hookWrapperPath, hooksJsonPath } from "../paths.js";

export function uninstallCommand(purgeData: boolean, home = homedir()): string {
  const hooksPath = hooksJsonPath(home);
  if (existsSync(hooksPath)) {
    const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      version: number;
      hooks: Record<string, unknown[]>;
    };
    for (const [event, list] of Object.entries(hooks.hooks ?? {})) {
      hooks.hooks[event] = (list ?? []).filter((entry) => {
        if (typeof entry !== "object" || entry === null || !("command" in entry)) return true;
        return !String((entry as { command: string }).command).includes("llm-budget");
      });
      if (hooks.hooks[event].length === 0) delete hooks.hooks[event];
    }
    writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
  }

  const wrapper = hookWrapperPath(home);
  if (existsSync(wrapper)) rmSync(wrapper);

  const lines = ["Removed llm-budget Cursor Agent hook entries and wrapper."];
  if (purgeData) {
    writeConfig(structuredClone(DEFAULT_CONFIG), home);
    const db = openDb(home);
    setCursorOverride(db, "");
    setState(db, PERIOD_USAGE_CACHE_KEY, "");
    db.exec("DELETE FROM usage_events");
    db.exec("DELETE FROM warning_emissions");
    lines.push("Removed Cursor Agent data from the shared store; Claude Code and Codex config kept.");
  } else {
    lines.push("Kept Cursor Agent data in the shared store.");
  }
  return `${lines.join("\n")}\n`;
}
