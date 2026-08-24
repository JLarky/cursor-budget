import { ensureLlmConfig, type LlmConfig } from "./config.js";
import {
  formatGuardDeny,
  runGuard,
  type GuardDeps,
  type GuardDecision,
} from "./guard.js";

/**
 * Claude Code hook events the guard enforces on.
 *
 * UserPromptSubmit gates the prompt before any API spend; PreToolUse gates
 * every tool call so a long-running session stops at the next turn boundary
 * rather than mid-flight. `Stop` is deliberately NOT registered — it fires
 * after the response is already billed, and blocking it only makes Claude
 * keep working, which is the opposite of what a budget guard wants.
 */
export const CLAUDE_ENFORCE_EVENTS = new Set(["UserPromptSubmit", "PreToolUse"]);

export interface ClaudeHookEvent {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

export interface ClaudeHookResponse {
  block: boolean;
  message?: string;
  eventName: string;
  sessionId: string;
}

export interface ClaudeHookDeps extends GuardDeps {
  config?: LlmConfig;
}

/**
 * Decide allow/block for one Claude Code hook event.
 *
 * Mirrors cursor-budget's handleHook: config load failures deny enforce
 * events with an escape-hatch message; guard failures become usageUnknown
 * blocks under failClosed; exceptions and overrides short-circuit first.
 */
export function handleClaudeHook(
  event: ClaudeHookEvent,
  deps: ClaudeHookDeps = {},
): ClaudeHookResponse {
  const eventName = String(event.hook_event_name ?? "");
  const sessionId = String(event.session_id ?? "");
  const base: ClaudeHookResponse = { block: false, eventName, sessionId };

  if (!CLAUDE_ENFORCE_EVENTS.has(eventName)) return base;

  let config: LlmConfig;
  try {
    // Load inside the handler so a broken config.json denies (fail closed)
    // instead of bypassing via a default-parameter throw.
    config = deps.config ?? ensureLlmConfig(deps.home);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      block: true,
      message: [
        "llm-budget failed to load config:",
        `  ${detail}`,
        "",
        `Session id: ${sessionId || "unknown"}`,
        "",
        "Recover with:",
        "  llm-budget override 30m",
        `  llm-budget except add ${sessionId || "<session-id>"}`,
      ].join("\n"),
    };
  }

  let decision: GuardDecision;
  try {
    decision = runGuard("claude", config, { ...deps, sessionId });
  } catch (error) {
    // Belt-and-braces: runGuard already converts expected failures into
    // decisions; anything escaping here still fails closed on enforce events.
    const detail = error instanceof Error ? error.message : String(error);
    if (!config.enforcement.failClosed) return base;
    return {
      ...base,
      block: true,
      message:
        `llm-budget failed closed: ${detail}\n\nSession id: ${sessionId || "unknown"}\n\n` +
        `Recover with:\n  llm-budget override 30m\n  llm-budget except add ${sessionId || "<session-id>"}`,
    };
  }

  if (decision.allow) return base;
  return {
    ...base,
    block: true,
    message: formatGuardDeny(decision, "claude", sessionId),
  };
}

const STDIN_TIMEOUT_MS = 2_000;

export class ClaudeHookInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeHookInputError";
  }
}

/**
 * Parse one hook payload. Claude Code always pipes JSON, so empty or
 * unparseable input means something upstream is broken (truncated pipe,
 * hijacked stdin) — callers must fail closed rather than read it as
 * "no event".
 */
export function parseClaudeHookInput(raw: string): ClaudeHookEvent {
  if (!raw.trim()) {
    throw new ClaudeHookInputError("hook produced no input on stdin");
  }
  try {
    return JSON.parse(raw) as ClaudeHookEvent;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ClaudeHookInputError(`hook input is not valid JSON: ${detail}`);
  }
}

/** Read one hook event from stdin (Claude Code pipes JSON per event). */
export async function readClaudeHookEvent(
  timeoutMs = STDIN_TIMEOUT_MS,
): Promise<ClaudeHookEvent> {
  const raw = await new Promise<string>((resolve, reject) => {
    let data = "";
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      // Stop flowing so an open pipe does not keep the hook process alive
      // after we have already answered.
      process.stdin.pause();
      resolve(value);
    };
    const onData = (chunk: string | Buffer) => {
      data += typeof chunk === "string" ? chunk : chunk.toString("utf8");
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
  // Empty/unparseable input throws so the CLI can block explicitly instead
  // of silently treating it as a non-enforcement event.
  return parseClaudeHookInput(raw);
}
