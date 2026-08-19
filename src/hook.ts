import { getProvider } from "./accounting/index.js";
import type { CursorHookEvent, Usage } from "./accounting/types.js";
import { evaluate, formatBlockMessage, formatPercent, formatUsd } from "./budget/evaluator.js";
import { activeWindows, calendarDay, rollingHour } from "./budget/windows.js";
import type { Config } from "./config.js";
import { ensureConfig } from "./config.js";
import { getState, hasWarning, markWarning, openDb } from "./db/client.js";
import { notify } from "./notify.js";
import { resolveRate } from "./pricing.js";

const ENFORCE_EVENTS = new Set([
  "beforeSubmitPrompt",
  "preToolUse",
  "beforeShellExecution",
  "beforeMCPExecution",
  "beforeReadFile",
  "subagentStart",
]);

const RECORD_EVENTS = new Set(["afterAgentThought", "afterAgentResponse", "preCompact"]);

const STDIN_TIMEOUT_MS = 2_000;

export interface HookResponse {
  continue: boolean;
  permission: "allow" | "deny";
  user_message?: string;
  agent_message?: string;
}

export async function handleHook(event: CursorHookEvent, config?: Config): Promise<HookResponse> {
  const eventName = String(event.hook_event_name ?? "");
  const conversationId = event.conversation_id ?? "";

  // Load config inside the handler so a bad config.json cannot bypass the catch
  // via a default-parameter throw and silently fail open in the CLI wrapper.
  let resolved: Config;
  try {
    resolved = config ?? ensureConfig();
  } catch (error) {
    if (ENFORCE_EVENTS.has(eventName)) {
      const detail = error instanceof Error ? error.message : String(error);
      return deny(
        `cursor-budget failed to load config: ${detail}\nSession id: ${conversationId || "unknown"}`,
      );
    }
    return allow();
  }

  const excluded = resolved.excludeConversationIds.includes(conversationId);

  try {
    return await dispatch(event, eventName, excluded, resolved);
  } catch (error) {
    if (resolved.enforcement.failClosed && ENFORCE_EVENTS.has(eventName) && !excluded) {
      const message = `cursor-budget failed closed: ${error instanceof Error ? error.message : String(error)}\nSession id: ${conversationId || "unknown"}`;
      return deny(message);
    }
    return allow();
  }
}

async function dispatch(
  event: CursorHookEvent,
  eventName: string,
  excluded: boolean,
  config: Config,
): Promise<HookResponse> {
  const provider = getProvider(config);

  if (ENFORCE_EVENTS.has(eventName)) {
    const now = new Date();
    const hourWindow = rollingHour(now);
    const dayWindow = calendarDay(now);
    const [hour, day] = await Promise.all([
      provider.getUsage(hourWindow),
      provider.getUsage(dayWindow),
    ]);
    const overrideUntil = readOverrideUntil();
    const model = event.model_id || event.model;
    const { matched } = resolveRate(model, config);
    const decision = evaluate({
      hour,
      day,
      config,
      overrideUntil,
      now,
      excluded,
      unknownModel: Boolean(model) && !matched,
    });

    if (!decision.allow) {
      const message = formatBlockMessage(decision, hour, day, config, event.conversation_id);
      return deny(message);
    }

    if (eventName === "beforeSubmitPrompt" && provider.recordEvent) {
      await provider.recordEvent(event);
    }
    if (!excluded && !decision.overrideActive) {
      maybeWarn(config, hour, day, now);
    }
    return allow();
  }

  if (RECORD_EVENTS.has(eventName) && provider.recordEvent) {
    await provider.recordEvent(event);
  }
  return allow();
}

function readOverrideUntil(): Date | null {
  const raw = getState(openDb(), "override_until");
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function maybeWarn(config: Config, hour: Usage, day: Usage, now: Date): void {
  const db = openDb();
  for (const window of activeWindows(now)) {
    const usage = window.id === "rollingHour" ? hour : day;
    const limit = config.limits[window.id];
    const usdLimit = limit.usd;
    const tokenLimit = limit.tokens;
    const usdRatio = usdLimit && usage.usd != null ? usage.usd / usdLimit : 0;
    const tokenRatio = tokenLimit ? usage.totalTokens / tokenLimit : 0;
    const ratio = Math.max(usdRatio, tokenRatio);
    const periodKey =
      window.id === "calendarDay"
        ? localDateKey(now)
        : String(Math.floor(now.getTime() / 3_600_000));
    for (const threshold of config.warnings) {
      if (ratio < threshold) continue;
      if (hasWarning(db, window.id, threshold, periodKey)) continue;
      markWarning(db, window.id, threshold, periodKey, now.toISOString());
      const usedUsd = usage.usd ?? 0;
      const text =
        usdLimit != null
          ? `LLM budget: ${Math.round(ratio * 100)}% of ${window.label.toLowerCase()} limit used\n${formatUsd(usedUsd)} / ${formatUsd(usdLimit)}`
          : `LLM budget: ${formatPercent(usage.totalTokens, tokenLimit)} of ${window.label.toLowerCase()} token limit used`;
      notify("cursor-budget", text);
    }
  }
}

function localDateKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function allow(): HookResponse {
  return { continue: true, permission: "allow" };
}

function deny(message: string): HookResponse {
  return {
    continue: false,
    permission: "deny",
    user_message: message,
    agent_message: message,
  };
}

export async function readStdinJson(timeoutMs = STDIN_TIMEOUT_MS): Promise<CursorHookEvent> {
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
    const timer = setTimeout(() => {
      // Fail open: empty event so the hook allows rather than hanging Cursor.
      finish("");
    }, timeoutMs);

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);

    // stdin may already be ended (piped fully before listeners attach).
    if (process.stdin.readableEnded) {
      finish(data);
    }
  });
  if (!raw.trim()) return {};
  return JSON.parse(raw) as CursorHookEvent;
}
