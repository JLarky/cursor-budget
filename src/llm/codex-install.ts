import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLlmConfig } from "./config.js";
import { codexHookWrapperPath, codexHooksPath } from "./paths.js";

const EVENTS = ["UserPromptSubmit", "PreToolUse"] as const;
interface HookGroup { matcher?: string; hooks: Array<Record<string, unknown>>; }
function owned(entry: unknown): boolean {
  return typeof entry === "object" && entry !== null && "command" in entry &&
    String((entry as { command: unknown }).command).includes("llm-budget");
}
export function installCodexHooks(home = homedir()): string {
  ensureLlmConfig(home);
  const wrapper = codexHookWrapperPath(home), path = codexHooksPath(home);
  const cli = join(fileURLToPath(new URL("./cli.js", import.meta.url)));
  mkdirSync(dirname(wrapper), { recursive: true });
  writeFileSync(wrapper, `#!/bin/bash
NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then echo "llm-budget: node not found; cannot check budget" >&2; exit 2; fi
exec "$NODE" ${JSON.stringify(cli)} codex hook
`);
  chmodSync(wrapper, 0o755);
  let config: Record<string, unknown> = {};
  if (existsSync(path)) config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const hooks = typeof config.hooks === "object" && config.hooks !== null ? config.hooks as Record<string, unknown> : {};
  for (const event of EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] as HookGroup[] : [];
    if (!groups.some((group) => (group?.hooks ?? []).some(owned))) {
      const group: HookGroup = { hooks: [{ type: "command", command: wrapper }] };
      if (event === "PreToolUse") group.matcher = "*";
      groups.push(group);
    }
    hooks[event] = groups;
  }
  config.hooks = hooks;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return `Installed llm-budget Codex native hooks\n  ${path}\n  ${wrapper}\n\nRestart any running Codex sessions so they pick up hooks.json.\n\nThe PATH shim remains an optional startup belt for older Codex versions.`;
}
export function uninstallCodexHooks(home = homedir()): string {
  const path = codexHooksPath(home);
  if (!existsSync(path)) return "No llm-budget Codex hooks found.\n";
  const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const hooks = config.hooks;
  if (typeof hooks !== "object" || hooks === null) return "No llm-budget Codex hooks found.\n";
  let changed = false;
  for (const event of EVENTS) {
    const map = hooks as Record<string, unknown>;
    const groups = Array.isArray(map[event]) ? map[event] as HookGroup[] : [];
    const next = groups.map((g) => ({ ...g, hooks: (g?.hooks ?? []).filter((h) => !owned(h)) })).filter((g) => g.hooks.length > 0);
    if (next.length !== groups.length) changed = true;
    if (next.length) map[event] = next; else delete map[event];
  }
  if (changed) writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return changed ? `Removed llm-budget Codex hooks from ${path}\n` : "No llm-budget Codex hooks found.\n";
}
export function codexHooksInstalled(home = homedir()): boolean {
  try {
    const config = JSON.parse(readFileSync(codexHooksPath(home), "utf8")) as { hooks?: Record<string, unknown> };
    return EVENTS.every((event) => (Array.isArray(config.hooks?.[event]) ? config.hooks[event] as HookGroup[] : []).some((g) => (g?.hooks ?? []).some(owned)));
  } catch { return false; }
}
