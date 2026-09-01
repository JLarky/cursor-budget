import { homedir } from "node:os";
import { ensureConfig, loadConfigForRead, writeConfig, type Config } from "../config.js";
import { getState, openLlmDb, setState } from "../llm/db.js";
import { configPath } from "../paths.js";
import { parseDuration } from "../budget/windows.js";
import { GROK_OVERRIDE_KEY } from "../db/keys.js";
import { asJsonObject, jsonString, parseJsonText, type JsonValue } from "../json-value.js";
import { grokDenyJson, grokHookInstalled, installGrokHook, uninstallGrokHook } from "./install.js";
import {
  decide,
  gateFromConfig,
  renderDenyReason,
  renderGrokStatus,
  type GateState,
  type GrokRequest,
  type Verdict,
} from "./policy.js";
import { readGrokWeekly } from "./weekly.js";

export class GrokHookInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrokHookInputError";
  }
}

const ENFORCEABLE_EVENT_NAMES = new Set(["pre_tool_use", "PreToolUse", "preToolUse"]);
const STDIN_TIMEOUT_MS = 2_000;

/**
 * Parse one Grok hook payload at the boundary. Empty or non-object stdin
 * throws, so a broken pipe reaches `runGrokHook`'s catch (deny) rather than
 * being misread as an unenforceable passive event.
 *
 * Grok is camelCase (`hookEventName`, `sessionId`); Claude's snake_case
 * aliases are accepted because Grok may scan `~/.claude/settings.json`.
 * `GROK_SESSION_ID` / `GROK_HOOK_EVENT` fill a missing field only, never
 * override the payload.
 */
export function parseGrokRequest(raw: string, env: NodeJS.ProcessEnv = process.env): GrokRequest {
  if (!raw.trim()) throw new GrokHookInputError("Grok hook produced no input on stdin");
  let parsed: JsonValue;
  try {
    parsed = parseJsonText(raw);
  } catch (error) {
    throw new GrokHookInputError(
      `Grok hook input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const obj = asJsonObject(parsed);
  if (obj === null) throw new GrokHookInputError("Grok hook input is not a JSON object");

  const rawEvent =
    jsonString(obj.hookEventName) ?? jsonString(obj.hook_event_name) ?? env.GROK_HOOK_EVENT ?? "";
  const sessionId =
    jsonString(obj.sessionId) ?? jsonString(obj.session_id) ?? env.GROK_SESSION_ID ?? "";

  if (ENFORCEABLE_EVENT_NAMES.has(rawEvent)) {
    const toolName = jsonString(obj.toolName) ?? jsonString(obj.tool_name);
    return { kind: "enforceable", event: "pre_tool_use", sessionId, toolName };
  }
  return { kind: "passive", event: rawEvent || "unknown", sessionId };
}

function readGrokHookStdin(timeoutMs = STDIN_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      process.stdin.pause();
      resolve(value);
    };
    const onData = (chunk: string | Buffer) => {
      data += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    };
    const onEnd = () => finish(data);
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => finish(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
    if (process.stdin.readableEnded) finish(data);
  });
}

export interface GrokGateDeps {
  readonly home?: string;
  readonly now?: Date;
  readonly config?: Config;
}

/**
 * One I/O call, one value: config, the weekly reading, the override
 * deadline, and the exception list. Shared by the hook and by status, which
 * is the only reason the number in `llm-budget status` is provably the
 * number the gate enforces.
 */
export async function grokGateState(deps: GrokGateDeps = {}): Promise<GateState> {
  const now = deps.now ?? new Date();
  // No default: a broken config file must throw here so the hook fails closed.
  const config = deps.config ?? ensureConfig(deps.home);
  const db = openLlmDb(deps.home);
  const overrideRaw = getState(db, GROK_OVERRIDE_KEY);
  const overrideUntil = overrideRaw ? new Date(overrideRaw) : null;
  const weekly = await readGrokWeekly({ home: deps.home, now, db });
  return {
    gate: gateFromConfig(config.grok),
    weekly,
    overrideUntil,
    exceptedSessionIds: config.grok.excludeSessionIds,
    failClosed: config.enforcement.failClosed,
    now,
  };
}

export type GrokReply = { readonly kind: "allow" } | { readonly kind: "deny"; readonly reason: string };

/** Deny writes stdout JSON, a stderr copy, and exit 2. Allow is silent, exit 0. */
export function emitGrokReply(reply: GrokReply): void {
  if (reply.kind === "allow") {
    process.exitCode = 0;
    return;
  }
  process.stdout.write(`${grokDenyJson(reply.reason)}\n`);
  process.stderr.write(`${reply.reason}\n`);
  process.exitCode = 2;
}

/**
 * `grok hook` entry point. try/catch around parse -> gate -> decide -> emit;
 * the catch path always emits a deny rather than rethrowing to a crash the
 * wrapper would read as fail-open.
 */
export async function runGrokHook(deps: GrokGateDeps = {}): Promise<void> {
  let verdict: Verdict;
  try {
    const raw = await readGrokHookStdin();
    const request = parseGrokRequest(raw);
    verdict =
      request.kind === "passive"
        ? { kind: "allow", why: "eventCannotDeny" }
        : decide(await grokGateState(deps), request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitGrokReply({
      kind: "deny",
      reason: `llm-budget could not verify the Grok budget: ${message}. Recover with: llm-budget grok override 30m | llm-budget grok status`,
    });
    return;
  }
  emitGrokReply(
    verdict.kind === "allow" ? { kind: "allow" } : { kind: "deny", reason: renderDenyReason(verdict.report) },
  );
}

/** The `Grok CLI:` block for both `llm-budget status` and `llm-budget grok status`. */
export async function grokStatusSection(home = homedir(), now = new Date()): Promise<string> {
  const { config } = loadConfigForRead(home);
  const installed = grokHookInstalled(home);
  if (!config.grok.enabled) {
    return [
      "Grok CLI:",
      `  Hooks: ${installed ? "installed" : "not installed — run llm-budget grok install"}`,
      "  disabled in config",
    ].join("\n");
  }
  const state = await grokGateState({ home, now, config });
  const body = renderGrokStatus(state, { installed });
  return ["Grok CLI:", ...body.map((line) => `  ${line}`)].join("\n");
}

async function grokStatusCommand(home = homedir()): Promise<string> {
  const { config, warning } = loadConfigForRead(home);
  const now = new Date();
  const lines: string[] = [];
  if (warning) lines.push(warning, "");
  lines.push("llm-budget");
  lines.push(`Config: ${configPath(home)}`);
  lines.push(
    `On unknown usage: ${config.enforcement.failClosed ? "block (failClosed)" : "allow (failClosed off)"}`,
  );
  lines.push("");
  lines.push(await grokStatusSection(home, now));
  return `${lines.join("\n")}\n`;
}

export function grokOverrideCommand(spec: string | undefined, home = homedir()): string {
  ensureConfig(home);
  const db = openLlmDb(home);
  if (!spec || spec === "off") {
    setState(db, GROK_OVERRIDE_KEY, "");
    return "Override cleared. Limits will be enforced again.\n";
  }
  const ms = parseDuration(spec);
  if (ms == null) {
    throw new Error(
      "Usage:\n  llm-budget grok override <duration>   (e.g. 15m, 30m, 1h)\n  llm-budget grok override off",
    );
  }
  const until = new Date(Date.now() + ms);
  setState(db, GROK_OVERRIDE_KEY, until.toISOString());
  return `Override active until ${until.toLocaleString()}.\n`;
}

function formatGrokList(ids: readonly string[]): string {
  if (ids.length === 0) return "No session exceptions.\n";
  return `Session exceptions (${ids.length}):\n${ids.map((id) => `  ${id}`).join("\n")}\n`;
}

export function grokExceptCommand(args: string[], home = homedir()): string {
  const config = ensureConfig(home);
  const [actionOrId, maybeId] = args;
  if (!actionOrId || actionOrId === "list") return formatGrokList(config.grok.excludeSessionIds);

  if (actionOrId === "remove" || actionOrId === "rm") {
    const id = maybeId?.trim() ?? "";
    if (!id) throw new Error("Usage: llm-budget grok except remove <session-id>");
    const next = config.grok.excludeSessionIds.filter((existing) => existing !== id);
    writeConfig({ ...config, grok: { ...config.grok, excludeSessionIds: next } }, home);
    return next.length === config.grok.excludeSessionIds.length
      ? `No exception for ${id}.\n`
      : `Removed exception for ${id}.\n${formatGrokList(next)}`;
  }

  if (actionOrId.startsWith("-")) {
    throw new Error(
      "Usage: llm-budget grok except add <session-id>\n       llm-budget grok except remove <session-id>\n       llm-budget grok except list",
    );
  }
  const id = (actionOrId === "add" ? (maybeId ?? "") : actionOrId).trim();
  if (!id || (actionOrId === "add" && !maybeId) || id.startsWith("-")) {
    throw new Error("Usage: llm-budget grok except add <session-id>");
  }
  if (config.grok.excludeSessionIds.includes(id)) {
    return `Already excepted: ${id}\n${formatGrokList(config.grok.excludeSessionIds)}`;
  }
  const next = [...config.grok.excludeSessionIds, id];
  writeConfig({ ...config, grok: { ...config.grok, excludeSessionIds: next } }, home);
  return `Excepted ${id}. It will bypass the Grok gate.\n${formatGrokList(next)}`;
}

export const GROK_HELP = `llm-budget grok \u2014 Grok CLI guard

Commands:
  llm-budget grok install       Register the PreToolUse hook in ~/.grok/hooks/llm-budget.json
  llm-budget grok uninstall     Remove that hook file
  llm-budget grok status        Weekly credit usage, gate, and escape hatches
  llm-budget grok override <duration>
  llm-budget grok override off
  llm-budget grok except add <session-id>
  llm-budget grok except remove <session-id>
  llm-budget grok except list
  llm-budget grok hook          Used by the installed hook
  llm-budget grok help          This text
`;

/** `llm-budget grok ...` — Grok CLI scope. */
export async function grokScope(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "hook":
      await runGrokHook();
      return;
    case "status":
      process.stdout.write(await grokStatusCommand());
      return;
    case "override":
      process.stdout.write(grokOverrideCommand(rest[0]));
      return;
    case "except":
    case "exclude":
      process.stdout.write(grokExceptCommand(rest));
      return;
    case "install":
      process.stdout.write(installGrokHook());
      return;
    case "uninstall":
      process.stdout.write(uninstallGrokHook());
      return;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(GROK_HELP);
      return;
    default:
      throw new Error(`Unknown command: llm-budget grok ${sub}\nRun \`llm-budget grok help\`.`);
  }
}
