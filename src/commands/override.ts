import { parseDuration } from "../budget/windows.js";
import { ensureConfig } from "../config.js";
import { openDb, setState } from "../db/client.js";

export function overrideCommand(spec: string | undefined): string {
  ensureConfig();
  const db = openDb();
  if (!spec || spec === "off") {
    setState(db, "override_until", "");
    return "Override cleared. Limits will be enforced again.\n";
  }
  const ms = parseDuration(spec);
  if (ms == null) {
    throw new Error("Override duration must look like 15m, 30m, 1h, or off");
  }
  const until = new Date(Date.now() + ms);
  setState(db, "override_until", until.toISOString());
  return `Override active until ${until.toLocaleString()}. Usage is still recorded.\n`;
}
