import {
  CursorApiError,
  CursorUsageUnavailableError,
  getCursorPeriodUsage,
  getProvider,
  type CursorPeriodUsageResult,
  type GetCursorPeriodUsageOptions,
} from "./accounting/index.js";
import type { CursorHookEvent } from "./accounting/types.js";
import { evaluate, formatBlockMessage, formatPercentValue } from "./budget/evaluator.js";
import { rollingHour } from "./budget/windows.js";
import type { Config } from "./config.js";
import { ensureConfig } from "./config.js";
import { getState, hasWarning, markWarning, openDb } from "./db/client.js";
import { notify } from "./notify.js";

const ENFORCE_EVENTS = new Set([
  "beforeSubmitPrompt",
  "preToolUse",
  "beforeShellExecution",
  "beforeMCPExecution",
  "beforeReadFile",
  "subagentStart",
]);

const RECORD_EVENTS = new Set(["afterAgentThought", "afterAgentResponse"]);

const STDIN_TIMEOUT_MS = 2_000;

export interface HookResponse {
  continue: boolean;
  permission: "allow" | "deny";
  user_message?: string;
  agent_message?: string;
}

export interface HookDeps {
  home?: string;
  getPeriodUsage?: (options: GetCursorPeriodUsageOptions) => Promise<CursorPeriodUsageResult>;
  now?: Date;
}

export async function handleHook(
  event: CursorHookEvent,
  config?: Config,
  deps: HookDeps = {},
): Promise<HookResponse> {
  const eventName = String(event.hook_event_name ?? "");
  const conversationId = event.conversation_id ?? "";

  // Load config inside the handler so a bad config.json cannot bypass the catch
  // via a default-parameter throw and silently fail open in the CLI wrapper.
  let resolved: Config;
  try {
    resolved = config ?? ensureConfig(deps.home);
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
    return await dispatch(event, eventName, excluded, resolved, deps);
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
  deps: HookDeps,
): Promise<HookResponse> {
  const home = deps.home;
  const provider = getProvider(config, home);
  const now = deps.now ?? new Date();

  if (ENFORCE_EVENTS.has(eventName)) {
    const hourWindow = rollingHour(now);
    const eventsLastHour = await provider.countEvents(hourWindow);

    const { periodUsage, authHint } = await resolvePeriodUsage(config, deps, now);
    const overrideUntil = readOverrideUntil(home);
    const decision = evaluate({
      periodUsage,
      eventsLastHour,
      config,
      overrideUntil,
      now,
      excluded,
    });

    if (!decision.allow) {
      const message = formatBlockMessage(
        decision,
        periodUsage,
        eventsLastHour,
        config,
        event.conversation_id,
      );
      return deny(message);
    }

    if (eventName === "beforeSubmitPrompt" && provider.recordEvent) {
      await provider.recordEvent(event);
    }
    if (!excluded && !decision.overrideActive && periodUsage) {
      maybeWarn(config, periodUsage, now, home);
    }

    if (authHint) {
      return allow(authHint);
    }
    return allow();
  }

  if (RECORD_EVENTS.has(eventName) && provider.recordEvent) {
    await provider.recordEvent(event);
  }
  return allow();
}

/**
 * Apply the §5 failure policy for the primary (Cursor API) gate.
 * Returns `periodUsage: null` when the primary gate must fail open.
 */
export async function resolvePeriodUsage(
  config: Config,
  deps: HookDeps = {},
  now: Date = new Date(),
): Promise<{ periodUsage: CursorPeriodUsageResult | null; authHint?: string }> {
  const getUsage = deps.getPeriodUsage ?? getCursorPeriodUsage;
  try {
    const result = await getUsage({
      home: deps.home,
      cacheTtlMs: config.quota.cacheTtlMs,
      now,
    });

    if (result.source === "stale-cache" && result.ageMs > config.quota.maxStaleMs) {
      return { periodUsage: null };
    }
    return { periodUsage: result };
  } catch (error) {
    if (isAuthFailure(error)) {
      return {
        periodUsage: null,
        authHint:
          "cursor-budget: Cursor auth expired or missing. Re-authenticate with cursor-agent, then retry.",
      };
    }
    if (error instanceof CursorUsageUnavailableError) {
      if (config.enforcement.failClosed) {
        throw error;
      }
      return { periodUsage: null };
    }
    if (config.enforcement.failClosed) {
      throw error;
    }
    return { periodUsage: null };
  }
}

function isAuthFailure(error: unknown): boolean {
  if (error instanceof CursorApiError && error.status === 401) return true;
  if (error instanceof CursorUsageUnavailableError) {
    const cause = error.causeError;
    if (cause instanceof CursorApiError && cause.status === 401) return true;
  }
  return false;
}

function readOverrideUntil(home?: string): Date | null {
  const raw = getState(openDb(home), "override_until");
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function maybeWarn(
  config: Config,
  periodUsage: CursorPeriodUsageResult,
  now: Date,
  home?: string,
): void {
  const cycleEnd = periodUsage.usage.billingCycleEnd;
  if (!cycleEnd) return;
  const periodKey = cycleEnd.toISOString();
  const db = openDb(home);
  const plan = periodUsage.usage.planUsage;

  warnMeter({
    db,
    windowId: "cursorModels",
    label: "Cursor Models",
    percentUsed: plan.autoPercentUsed,
    blockAt: config.quota.cursorModelsBlockAtPercent,
    warnings: config.warnings,
    periodKey,
    now,
  });
  warnMeter({
    db,
    windowId: "otherModels",
    label: "Other Models",
    percentUsed: plan.apiPercentUsed,
    blockAt: config.quota.otherModelsBlockAtPercent,
    warnings: config.warnings,
    periodKey,
    now,
  });
}

function warnMeter(input: {
  db: ReturnType<typeof openDb>;
  windowId: string;
  label: string;
  percentUsed: number | null;
  blockAt: number;
  warnings: number[];
  periodKey: string;
  now: Date;
}): void {
  const { db, windowId, label, percentUsed, blockAt, warnings, periodKey, now } = input;
  if (percentUsed == null || !Number.isFinite(percentUsed) || !(blockAt > 0)) return;
  // warnings are 0–1 fractions of the block threshold; API percent is 0–100.
  const ratio = percentUsed / blockAt;
  for (const threshold of warnings) {
    if (ratio < threshold) continue;
    if (hasWarning(db, windowId, threshold, periodKey)) continue;
    markWarning(db, windowId, threshold, periodKey, now.toISOString());
    notify(
      "cursor-budget",
      `LLM budget: ${Math.round(ratio * 100)}% of ${label} block threshold\n${formatPercentValue(percentUsed)} used (block at ${formatPercentValue(blockAt)})`,
    );
  }
}

function allow(userMessage?: string): HookResponse {
  if (userMessage) {
    return { continue: true, permission: "allow", user_message: userMessage };
  }
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
      // Stop flowing so an open pipe does not keep the hook process alive
      // after we have already answered (hook runners wait for exit).
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
