import { ensureConfig, writeConfig } from "../config.js";

function normalizeId(raw: string): string {
  return raw.trim();
}

export function exceptCommand(args: string[], home?: string): string {
  const config = ensureConfig(home);
  const [actionOrId, maybeId] = args;
  if (!actionOrId || actionOrId === "list") {
    return formatList(config.excludeConversationIds);
  }

  if (actionOrId === "remove" || actionOrId === "rm") {
    const id = maybeId ? normalizeId(maybeId) : "";
    if (!id) throw new Error("Usage: cursor-budget except remove <session-id>");
    const next = config.excludeConversationIds.filter((existing) => existing !== id);
    writeConfig({ ...config, excludeConversationIds: next }, home);
    return next.length === config.excludeConversationIds.length
      ? `No exception for ${id}.\n`
      : `Removed exception for ${id}.\n${formatList(next)}`;
  }

  if (actionOrId.startsWith("-")) {
    throw new Error(
      "Usage: cursor-budget except add <session-id>\n       cursor-budget except remove <session-id>\n       cursor-budget except list",
    );
  }
  const id = normalizeId(actionOrId === "add" ? (maybeId ?? "") : actionOrId);
  if (!id || (actionOrId === "add" && !maybeId) || id.startsWith("-")) {
    throw new Error("Usage: cursor-budget except add <session-id>");
  }
  if (config.excludeConversationIds.includes(id)) {
    return `Already excepted: ${id}\n${formatList(config.excludeConversationIds)}`;
  }
  const next = [...config.excludeConversationIds, id];
  writeConfig({ ...config, excludeConversationIds: next }, home);
  return `Excepted ${id}. It will not be blocked and will not count toward limits.\n${formatList(next)}`;
}

function formatList(ids: string[]): string {
  if (ids.length === 0) return "No session exceptions.\n";
  return `Session exceptions (${ids.length}):\n${ids.map((id) => `  ${id}`).join("\n")}\n`;
}
