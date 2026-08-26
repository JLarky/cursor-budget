import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import {
  parse as parseToml,
  stringify as stringifyToml,
  type TomlTableWithoutBigInt,
  type TomlValueWithoutBigInt,
} from "smol-toml";
import {
  asJsonArray,
  asJsonObject,
  emptyJsonObject,
  jsonString,
  parseJsonText,
  type JsonArray,
  type JsonValue,
} from "../json-value.js";
import { ensureLlmConfig } from "./config.js";
import { codexHookWrapperPath, codexHooksPath, codexHookStatePath, codexShimDir } from "./paths.js";

const EVENTS = ["UserPromptSubmit", "PreToolUse"] as const;

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

function asTomlTable(value: TomlValueWithoutBigInt | undefined): TomlTableWithoutBigInt | null {
  if (value === undefined || Array.isArray(value) || value instanceof Date) return null;
  if (v.safeParse(v.string(), value).success) return null;
  if (v.safeParse(v.number(), value).success) return null;
  if (v.safeParse(v.boolean(), value).success) return null;
  // SAFETY: remaining TomlValueWithoutBigInt cases are tables.
  return value as TomlTableWithoutBigInt;
}

function readOwnedState(home: string): OwnedState[] {
  try {
    const value = asJsonObject(parseJsonText(readFileSync(codexHookStatePath(home), "utf8")));
    const state = asJsonArray(value?.state);
    if (!state) return [];
    const owned: OwnedState[] = [];
    for (const entry of state) {
      const obj = asJsonObject(entry);
      if (!obj) continue;
      const key = jsonString(obj.key);
      const trustedHash = jsonString(obj.trusted_hash);
      if (key === null || trustedHash === null) continue;
      owned.push({ key, trusted_hash: trustedHash });
    }
    return owned;
  } catch {
    return [];
  }
}

function writeOwnedState(home: string, state: OwnedState[]): void {
  mkdirSync(dirname(codexHookStatePath(home)), { recursive: true });
  writeFileSync(codexHookStatePath(home), `${JSON.stringify({ state }, null, 2)}\n`);
}

function readCodexHookInfo(value: JsonValue): CodexHookInfo | null {
  const obj = asJsonObject(value);
  if (!obj) return null;
  return {
    key: jsonString(obj.key) ?? undefined,
    command: jsonString(obj.command) ?? undefined,
    currentHash: jsonString(obj.currentHash) ?? undefined,
    trustStatus: jsonString(obj.trustStatus) ?? undefined,
  };
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
      const message = asJsonObject(parseJsonText(line));
      if (!message || message.id !== 2) continue;
      const payload = asJsonObject(message.result);
      const data = asJsonArray(payload?.data) ?? [];
      const hooks: CodexHookInfo[] = [];
      for (const item of data) {
        const itemObj = asJsonObject(item);
        const itemHooks = asJsonArray(itemObj?.hooks) ?? [];
        for (const hook of itemHooks) {
          const info = readCodexHookInfo(hook);
          if (info) hooks.push(info);
        }
      }
      return hooks;
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
  let config: TomlTableWithoutBigInt = {};
  if (existsSync(configPath)) config = parseToml(readFileSync(configPath, "utf8"), {});
  const hooks = asTomlTable(config.hooks) ?? {};
  const state = asTomlTable(hooks.state) ?? {};
  const priorState = readOwnedState(home);
  for (const prior of priorState) {
    const current = state[prior.key];
    if (current === undefined) {
      delete state[prior.key];
      continue;
    }
    const currentTable = asTomlTable(current);
    if (currentTable && currentTable.trusted_hash === prior.trusted_hash) {
      delete state[prior.key];
    }
  }
  const ownedState: OwnedState[] = [];
  for (const hook of ours) {
    const key = hook.key;
    const currentHash = hook.currentHash;
    if (!key || !currentHash) continue;
    state[key] = { enabled: true, trusted_hash: currentHash };
    ownedState.push({ key, trusted_hash: currentHash });
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

function owned(entry: JsonValue, wrapper: string): boolean {
  const obj = asJsonObject(entry);
  if (!obj || !("command" in obj)) return false;
  return obj.command === wrapper;
}

function groupHooks(group: JsonValue): JsonArray {
  const obj = asJsonObject(group);
  return asJsonArray(obj?.hooks) ?? [];
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
  let config = emptyJsonObject();
  if (existsSync(path)) {
    try {
      config = asJsonObject(parseJsonText(readFileSync(path, "utf8"))) ?? emptyJsonObject();
    } catch {
      return `Cannot install Codex hooks: ${path} is malformed; preserving it unchanged.`;
    }
  }
  const hooks = asJsonObject(config.hooks) ?? emptyJsonObject();
  for (const event of EVENTS) {
    const groups = asJsonArray(hooks[event]) ?? [];
    if (!groups.some((group) => groupHooks(group).some((hook) => owned(hook, wrapper)))) {
      const group = emptyJsonObject();
      group.hooks = [{ type: "command", command: wrapper }];
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
  let config = emptyJsonObject();
  let hooksParsed = !existsSync(path);
  if (existsSync(path)) {
    try {
      const parsed = asJsonObject(parseJsonText(readFileSync(path, "utf8")));
      hooksParsed = true;
      if (parsed) config = parsed;
    } catch {
      // Preserve malformed hooks.json byte-for-byte.
    }
  }
  const hookMap = asJsonObject(config.hooks);
  let hooksChanged = false;
  let trustChanged = false;
  if (hookMap) {
    for (const event of EVENTS) {
      const groups = asJsonArray(hookMap[event]) ?? [];
      const next: JsonArray = [];
      for (const group of groups) {
        const groupObj = asJsonObject(group) ?? emptyJsonObject();
        const inner = asJsonArray(groupObj.hooks) ?? [];
        const filtered = inner.filter((hook) => !owned(hook, wrapper));
        if (filtered.length !== inner.length) {
          hooksChanged = true;
        }
        if (filtered.length === 0) continue;
        next.push({ ...groupObj, hooks: filtered });
      }
      if (next.length) hookMap[event] = next; else delete hookMap[event];
    }
    config.hooks = hookMap;
  }
  const configPath = join(home, ".codex", "config.toml");
  if (ownedState.length && existsSync(configPath)) {
    let toml: TomlTableWithoutBigInt;
    try {
      toml = parseToml(readFileSync(configPath, "utf8"), {});
    } catch {
      return `Cannot remove Codex trust state: ${configPath} is malformed; preserving it unchanged.`;
    }
    const tomlHooks = asTomlTable(toml.hooks);
    const state = asTomlTable(tomlHooks?.state);
    if (state) {
      for (const ownedEntry of ownedState) {
        const current = asTomlTable(state[ownedEntry.key]);
        if (current && current.trusted_hash === ownedEntry.trusted_hash) {
          delete state[ownedEntry.key];
          trustChanged = true;
        }
      }
      writeFileSync(configPath, stringifyToml(toml));
    }
  }
  writeOwnedState(home, []);
  if (hooksChanged && hooksParsed && existsSync(path)) {
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  }
  const lines: string[] = [];
  if (!hooksParsed) {
    lines.push(
      `Warning: ${path} was left untouched because it is malformed; owned entries may still be present until you repair it and re-run uninstall.`,
    );
  } else if (hooksChanged) {
    lines.push(`Removed llm-budget Codex hooks from ${path}`);
  } else {
    lines.push("No llm-budget Codex hooks found.");
  }
  if (trustChanged) lines.push(`Removed llm-budget Codex trust state from ${configPath}`);
  return `${lines.join("\n")}\n`;
}

export function codexHooksInstalled(home = homedir()): boolean {
  try {
    const config = asJsonObject(parseJsonText(readFileSync(codexHooksPath(home), "utf8")));
    const hooks = asJsonObject(config?.hooks);
    if (!hooks) return false;
    const wrapper = codexHookWrapperPath(home);
    return EVENTS.every((event) => {
      const groups = asJsonArray(hooks[event]) ?? [];
      return groups.some((group) => groupHooks(group).some((hook) => owned(hook, wrapper)));
    });
  } catch {
    return false;
  }
}
