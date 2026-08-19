import { formatTokens, formatUsd } from "../budget/evaluator.js";
import { ensureConfig } from "../config.js";
import { listRecentEvents, openDb } from "../db/client.js";

export function historyCommand(): string {
  ensureConfig();
  const rows = listRecentEvents(openDb(), 25);
  if (rows.length === 0) return "No usage events yet.\n";
  const lines = ["Recent usage events (estimated, not billed)", ""];
  for (const row of rows) {
    lines.push(
      `${row.timestamp}  ${row.event_type.padEnd(22)}  ${formatTokens(row.estimated_tokens)} est tokens  ${formatUsd(row.estimated_cost_usd)}  ${row.model_id || row.model || "-"}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
