import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { PERIOD_USAGE_CACHE_KEY } from "../accounting/cursor-api.js";
import { DEFAULT_CONFIG, writeConfig } from "../config.js";
import { openDb, setCursorOverride, setState } from "../db/client.js";
import {
  asJsonArray,
  asJsonObject,
  parseJsonText,
  type JsonValue,
} from "../json-value.js";
import { hookWrapperPath, hooksJsonPath } from "../paths.js";

function isLlmBudgetEntry(entry: JsonValue): boolean {
  const obj = asJsonObject(entry);
  if (!obj || !("command" in obj)) return false;
  return String(obj.command).includes("llm-budget");
}

export function uninstallCommand(purgeData: boolean, home = homedir()): string {
  const hooksPath = hooksJsonPath(home);
  if (existsSync(hooksPath)) {
    const settings = asJsonObject(parseJsonText(readFileSync(hooksPath, "utf8")));
    if (settings) {
      const hookMap = asJsonObject(settings.hooks);
      if (hookMap) {
        for (const [event, list] of Object.entries(hookMap)) {
          const entries = asJsonArray(list);
          if (!entries) continue;
          const next = entries.filter((entry) => !isLlmBudgetEntry(entry));
          if (next.length === 0) delete hookMap[event];
          else hookMap[event] = next;
        }
        settings.hooks = hookMap;
      }
      writeFileSync(hooksPath, `${JSON.stringify(settings, null, 2)}\n`);
    }
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
