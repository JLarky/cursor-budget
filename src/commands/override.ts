import { parseDuration } from "../budget/windows.js";
import { ensureConfig } from "../config.js";
import { openDb, setCursorOverride } from "../db/client.js";

export function overrideCommand(spec: string | undefined): string {
  ensureConfig();
  const db = openDb();
  if (!spec || spec === "off") {
    setCursorOverride(db, "");
    return "Override cleared. Limits will be enforced again.\n";
  }
  const ms = parseDuration(spec);
  if (ms == null) {
    throw new Error(
      "Usage:\n  llm-budget cursor override <duration>   (e.g. 15m, 30m, 1h)\n  llm-budget cursor override off",
    );
  }
  const until = new Date(Date.now() + ms);
  setCursorOverride(db, until.toISOString());
  return `Override active until ${until.toLocaleString()}. Events are still recorded.\n`;
}
