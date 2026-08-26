import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLlmConfig } from "./config.js";
import { codexHookWrapperPath, codexHooksPath } from "./paths.js";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

const EVENTS = ["UserPromptSubmit", "PreToolUse"] as const;
interface HookGroup {
  matcher?: string;
  hooks: Array<Record<string, unknown>>;
}

interface CodexHookInfo {
  key?: string;
  command?: string;
  currentHash?: string;
  trustStatus?: string;
}

function listCodexHooks(home: string): CodexHookInfo[] {
  const input = [
    JSON.stringify({
      method: "initialize",
      id: 1,
      params: { clientInfo: { name: "llm-budget", version: "0.1.0" } },
    }),
    JSON.stringify({ method: "initialized" }),
    JSON.stringify({ method: "hooks/list", id: 2, params: {} }),
    "",
  ].join("\n");
  const quoted = input.replace(/'/g, "'\\''");
  const result = spawnSync("sh", ["-c", `(printf '%s' '${quoted}'; sleep 1) | codex app-server --listen stdio://`], {
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex") },
  });
  if (result.status !== 0 || !result.stdout) return [];
  for (const line of result.stdout.split("\n")) {
    try {
      const message = JSON.parse(line) as { id?: number; result?: { data?: Array<{ hooks?: CodexHookInfo[] }> } };
      if (message.id === 2) return message.result?.data?.flatMap((item) => item.hooks ?? []) ?? [];
    } catch {
      // app-server also emits notifications and diagnostics on stdout.
    }
  }
  return [];
}

function trustCodexHooks(home: string, wrapper: string): string {
  const ours = listCodexHooks(home).filter((hook) => hook.command === wrapper && hook.key && hook.currentHash);
  if (ours.length === 0) return "Codex hook trust could not be established automatically; approve hooks in Codex startup review.";
  const configPath = join(home, ".codex", "config.toml");
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) config = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const hooks = (typeof config.hooks === "object" && config.hooks !== null
    ? config.hooks as Record<string, unknown> : {});
  const state = (typeof hooks.state === "object" && hooks.state !== null
    ? hooks.state as Record<string, unknown> : {});
  for (const hook of ours) {
    state[hook.key!] = { enabled: true, trusted_hash: hook.currentHash };
  }

  hooks.state = state;
  config.hooks = hooks;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, stringifyToml(config));
  return `Trusted ${ours.length} Codex hook(s)`;
}

export function codexHookTrustStatus(
  home = homedir(),
  wrapper = codexHookWrapperPath(home),
): string {
  const ours = listCodexHooks(home).filter((hook) => hook.command === wrapper);
  if (ours.length === 0) return "unavailable";
  return [...new Set(ours.map((hook) => hook.trustStatus ?? "unknown"))].join(", ");
}

function owned(entry: unknown): boolean {
  return typeof entry === "object" && entry !== null && "command" in entry &&
    String((entry as { command: unknown }).command).includes("llm-budget");
}
export function installCodexHooks(home = homedir()): string {
  ensureLlmConfig(home);
  const wrapper = codexHookWrapperPath(home);
  const path = codexHooksPath(home);
  const cli = join(fileURLToPath(new URL("./cli.js", import.meta.url)));
  mkdirSync(dirname(wrapper), { recursive: true });
  writeFileSync(wrapper, `#!/bin/bash
NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then
  for candidate in "$HOME/.vite-plus/bin/node" /usr/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      NODE="$candidate"
      break
    fi
  done
fi
if [ -z "$NODE" ]; then
  echo "llm-budget: node not found; cannot check budget" >&2
  exit 2
fi
exec "$NODE" ${JSON.stringify(cli)} codex hook
`);
  chmodSync(wrapper, 0o755);
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  }
  const hooks =
    typeof config.hooks === "object" && config.hooks !== null
      ? config.hooks as Record<string, unknown>
      : {};
  for (const event of EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : [];
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
  const trust = trustCodexHooks(home, wrapper);
  return [
    "Installed llm-budget Codex native hooks",
    `  ${path}`,
    `  ${wrapper}`,
    "",
    "Restart any running Codex sessions so they pick up hooks.json.",
    trust,
    "",
    "The PATH shim remains an optional startup belt for older Codex versions.",
  ].join("\n");
}
export function uninstallCodexHooks(home = homedir()): string {
  const path = codexHooksPath(home);
  if (!existsSync(path)) return "No llm-budget Codex hooks found.\n";
  const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const hooks = config.hooks;
  if (typeof hooks !== "object" || hooks === null) return "No llm-budget Codex hooks found.\n";
  let changed = false;
  const removedKeys = new Set<string>();
  const installedHooks = listCodexHooks(home);
  for (const event of EVENTS) {
    const map = hooks as Record<string, unknown>;
    const groups = Array.isArray(map[event]) ? (map[event] as HookGroup[]) : [];
    const next = groups
      .map((group) => {
        const filtered = (group?.hooks ?? []).filter((hook) => !owned(hook));
        if (filtered.length !== (group?.hooks ?? []).length) {
          changed = true;
          for (const hook of group?.hooks ?? []) {
            if (owned(hook)) {
              for (const installed of installedHooks) {
                if (installed.command === (hook as { command?: string }).command && installed.key) {
                  removedKeys.add(installed.key);
                }
              }
            }
          }
        }
        return { ...group, hooks: filtered };
      })
      .filter((group) => group.hooks.length > 0);
    if (next.length) map[event] = next; else delete map[event];
  }
  const configPath = join(home, ".codex", "config.toml");
  if (removedKeys.size && existsSync(configPath)) {
    const toml = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const hooks = toml.hooks;
    const state = hooks && typeof hooks === "object" ? (hooks as Record<string, unknown>).state : undefined;
    if (state && typeof state === "object") {
      for (const key of removedKeys) {
        if (key in (state as Record<string, unknown>)) {
          delete (state as Record<string, unknown>)[key];
          changed = true;
        }
      }
      writeFileSync(configPath, stringifyToml(toml));
    }
  }
  if (changed) writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return changed ? `Removed llm-budget Codex hooks from ${path}\n` : "No llm-budget Codex hooks found.\n";
}
export function codexHooksInstalled(home = homedir()): boolean {
  try {
    const config = JSON.parse(readFileSync(codexHooksPath(home), "utf8")) as {
      hooks?: Record<string, unknown>;
    };
    return EVENTS.every((event) =>
      (Array.isArray(config.hooks?.[event]) ? (config.hooks[event] as HookGroup[]) : [])
        .some((group) => (group?.hooks ?? []).some(owned)),
    );
  } catch {
    return false;
  }
}
