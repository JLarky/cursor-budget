import { ensureConfig } from "../config.js";
import { listRecentEvents, openDb } from "../db/client.js";

export function historyCommand(home?: string): string {
  ensureConfig(home);
  const rows = listRecentEvents(openDb(home), 25);
  if (rows.length === 0) return "No usage events yet.\n";
  const lines = ["Recent usage events", ""];
  for (const row of rows) {
    lines.push(
      `${row.timestamp}  ${row.event_type.padEnd(22)}  ${row.model || "-"}  ${row.conversation_id || "-"}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
