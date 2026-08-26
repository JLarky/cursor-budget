import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLlmConfig } from "./config.js";
import { codexHookWrapperPath, codexHooksPath, codexHookStatePath, codexShimDir } from "./paths.js";
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

interface OwnedState {
  key: string;
  trusted_hash: string;
}

function readOwnedState(home: string): OwnedState[] {
  try {
    const value = JSON.parse(readFileSync(codexHookStatePath(home), "utf8")) as { state?: unknown };
    return Array.isArray(value.state)
      ? value.state.filter(
          (entry): entry is OwnedState =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as OwnedState).key === "string" &&
            typeof (entry as OwnedState).trusted_hash === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function writeOwnedState(home: string, state: OwnedState[]): void {
  mkdirSync(dirname(codexHookStatePath(home)), { recursive: true });
  writeFileSync(codexHookStatePath(home), `${JSON.stringify({ state }, null, 2)}\n`);
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
  const pathWithoutShim = (process.env.PATH ?? "").split(":").filter((entry) => entry !== codexShimDir(home)).join(":");
  const result = spawnSync("sh", ["-c", `(printf '%s' '${quoted}'; sleep 1) | codex app-server --listen stdio://`], {
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, PATH: pathWithoutShim, HOME: home, CODEX_HOME: join(home, ".codex") },
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
  const listed = listCodexHooks(home);
  const ours = listed.filter((hook) => hook.command === wrapper && hook.key && hook.currentHash);
  if (ours.length === 0) return "Codex hook trust could not be established automatically; approve hooks in Codex startup review.";
  const configPath = join(home, ".codex", "config.toml");
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) config = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const hooks = (typeof config.hooks === "object" && config.hooks !== null
    ? config.hooks as Record<string, unknown> : {});
  const state = (typeof hooks.state === "object" && hooks.state !== null
    ? hooks.state as Record<string, unknown> : {});
  const priorState = readOwnedState(home);
  for (const prior of priorState) {
    const current = state[prior.key];
    if (current === undefined || (current && typeof current === "object" &&
        (current as { trusted_hash?: unknown }).trusted_hash === prior.trusted_hash)) {
      delete state[prior.key];
    }
  }
  const ownedState: OwnedState[] = [];
  for (const hook of ours) {
    state[hook.key!] = { enabled: true, trusted_hash: hook.currentHash };
    ownedState.push({ key: hook.key!, trusted_hash: hook.currentHash! });
  }

  hooks.state = state;
  config.hooks = hooks;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, stringifyToml(config));
  writeOwnedState(home, ownedState);
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

function owned(entry: unknown, wrapper: string): boolean {
  return typeof entry === "object" && entry !== null && "command" in entry &&
    (entry as { command: unknown }).command === wrapper;
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
    if (!groups.some((group) => (group?.hooks ?? []).some((hook) => owned(hook, wrapper)))) {
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
    "Note: updating config.toml may rewrite its comments.",
    "",
    "The PATH shim remains an optional startup belt for older Codex versions.",
  ].join("\n");
}
export function uninstallCodexHooks(home = homedir()): string {
  const path = codexHooksPath(home);
  const wrapper = codexHookWrapperPath(home);
  const ownedState = readOwnedState(home);
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }
  const hooks = config.hooks;
  let changed = false;
  if (typeof hooks === "object" && hooks !== null) {
  for (const event of EVENTS) {
    const map = hooks as Record<string, unknown>;
    const groups = Array.isArray(map[event]) ? (map[event] as HookGroup[]) : [];
    const next = groups
      .map((group) => {
        const filtered = (group?.hooks ?? []).filter((hook) => !owned(hook, wrapper));
        if (filtered.length !== (group?.hooks ?? []).length) {
          changed = true;
          for (const hook of group?.hooks ?? []) {
            if (owned(hook, wrapper)) {
            }
          }
        }
        return { ...group, hooks: filtered };
      })
      .filter((group) => group.hooks.length > 0);
    if (next.length) map[event] = next; else delete map[event];
  }
  }
  const configPath = join(home, ".codex", "config.toml");
  if (ownedState.length && existsSync(configPath)) {
    const toml = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const hooks = toml.hooks;
    const state = hooks && typeof hooks === "object" ? (hooks as Record<string, unknown>).state : undefined;
    if (state && typeof state === "object") {
      for (const owned of ownedState) {
        const current = (state as Record<string, unknown>)[owned.key];
        if (current && typeof current === "object" &&
            (current as { trusted_hash?: unknown }).trusted_hash === owned.trusted_hash) {
          delete (state as Record<string, unknown>)[owned.key];
          changed = true;
        }
      }
      writeFileSync(configPath, stringifyToml(toml));
    }
  }
  writeOwnedState(home, []);
  if (changed && existsSync(path)) writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return changed ? `Removed llm-budget Codex hooks from ${path}\n` : "No llm-budget Codex hooks found.\n";
}
export function codexHooksInstalled(home = homedir()): boolean {
  try {
    const config = JSON.parse(readFileSync(codexHooksPath(home), "utf8")) as {
      hooks?: Record<string, unknown>;
    };
    return EVENTS.every((event) =>
      (Array.isArray(config.hooks?.[event]) ? (config.hooks[event] as HookGroup[]) : [])
        .some((group) => (group?.hooks ?? []).some((hook) => owned(hook, codexHookWrapperPath(home)))),
    );
  } catch {
    return false;
  }
}
