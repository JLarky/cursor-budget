import { parseJsonText } from "../json-value.js";
import { ensureConfig, type Config } from "../config.js";
import { formatGuardDeny, runGuard, type GuardDeps, type GuardDecision } from "./guard.js";

export const CODEX_ENFORCE_EVENTS = new Set(["UserPromptSubmit", "PreToolUse"]);
export interface CodexHookEvent { hook_event_name?: string; session_id?: string; }
export interface CodexHookResponse { block: boolean; message?: string; eventName: string; sessionId: string; }
export interface CodexHookDeps extends GuardDeps { config?: Config; }

export async function handleCodexHook(event: CodexHookEvent, deps: CodexHookDeps = {}): Promise<CodexHookResponse> {
  const eventName = String(event.hook_event_name ?? "");
  const sessionId = String(event.session_id ?? "");
  const base = { block: false, eventName, sessionId };
  if (!CODEX_ENFORCE_EVENTS.has(eventName)) return base;
  let config: Config;
  try { config = deps.config ?? ensureConfig(deps.home); }
  catch (error) {
    return { ...base, block: true, message: `llm-budget failed to load config: ${error instanceof Error ? error.message : String(error)}\n\nSession id: ${sessionId || "unknown"}\n\nRecover with:\n  llm-budget override 30m\n  llm-budget except add ${sessionId || "<session-id>"}` };
  }
  let decision: GuardDecision;
  try { decision = await runGuard("codex", config, { ...deps, sessionId }); }
  catch (error) {
    if (!config.enforcement.failClosed) return base;
    return { ...base, block: true, message: `llm-budget failed closed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (decision.allow) return base;
  return { ...base, block: true, message: formatGuardDeny(decision, "codex", sessionId) };
}

export class CodexHookInputError extends Error {
  constructor(message: string) { super(message); this.name = "CodexHookInputError"; }
}
export function parseCodexHookInput(raw: string): CodexHookEvent {
  if (!raw.trim()) throw new CodexHookInputError("hook produced no input on stdin");
  try {
    const value = parseJsonText(raw);
    // SAFETY: hook payloads are JSON objects; we only read known optional string fields.
    return value as CodexHookEvent;
  }
  catch (error) { throw new CodexHookInputError(`hook input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}
export async function readCodexHookEvent(timeoutMs = 2_000): Promise<CodexHookEvent> {
  const raw = await new Promise<string>((resolve, reject) => {
    let data = ""; let settled = false;
    const finish = (value: string) => {
      if (settled) return; settled = true; clearTimeout(timer);
      process.stdin.off("data", onData); process.stdin.off("end", onEnd); process.stdin.off("error", onError);
      process.stdin.pause(); resolve(value);
    };
    const onData = (chunk: string | Buffer) => { data += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk; };
    const onEnd = () => finish(data);
    const onError = (error: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
    const timer = setTimeout(() => finish(data), timeoutMs);
    process.stdin.setEncoding("utf8"); process.stdin.on("data", onData); process.stdin.on("end", onEnd); process.stdin.on("error", onError);
    if (process.stdin.readableEnded) finish(data);
  });
  return parseCodexHookInput(raw);
}
