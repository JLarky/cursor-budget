import {
  type Json,
  type ParserContext,
  type ParsedUsage,
  type TokenCounters,
  count,
  object,
  text,
} from "./types.js";

/**
 * Parsing rules mirror the prior art (fork-token-tracker's Codex parser,
 * version "codex-v1"):
 * - only per-call `last_token_usage` counts (cumulative `total_token_usage`
 *   is ignored — summing both would double-count);
 * - `cached_input_tokens` is a subset of `input_tokens`, and reasoning a
 *   subset of `output_tokens`, so both are subtracted out;
 * - cache-write tokens are reported by Codex but dropped (prior art keeps
 *   this at zero) to avoid counting the same prompt twice.
 */
export const CODEX_PARSER_VERSION = "codex-v1";

export function updateCodexContext(record: Json, context: ParserContext): ParserContext {
  const payload = object(record.payload);
  const session =
    record.type === "session_meta"
      ? text(payload.id) ?? text(payload.session_id)
      : text(payload.session_id);
  return {
    project: text(payload.cwd) ?? context.project,
    model: text(payload.model) ?? context.model,
    session: session ?? context.session,
  };
}

export function parseCodexUsage(record: Json, context: ParserContext): ParsedUsage | null {
  const payload = object(record.payload);
  const info = object(payload.info);
  const usage = object(info.last_token_usage);

  if (Object.keys(usage).length === 0) return null;

  const cachedInput = count(usage.cached_input_tokens);
  const reasoning = count(usage.reasoning_output_tokens) || count(usage.reasoning_tokens);

  const counters: TokenCounters = {
    inputTokens: Math.max(0, count(usage.input_tokens) - cachedInput),
    outputTokens: Math.max(0, count(usage.output_tokens) - reasoning),
    reasoningTokens: reasoning,
    cacheReadTokens: cachedInput,
    // Prior-art parity: Codex reports cache writes separately; we drop them.
    cacheWriteTokens: 0,
  };

  if (
    counters.inputTokens +
      counters.outputTokens +
      counters.reasoningTokens +
      counters.cacheReadTokens +
      counters.cacheWriteTokens ===
    0
  ) {
    return null;
  }

  return {
    counters,
    timestamp: text(record.timestamp) ?? text(payload.timestamp),
    session: text(payload.session_id) ?? context.session,
    model: text(payload.model) ?? context.model ?? "unknown",
    project: text(payload.cwd) ?? context.project,
    message: text(payload.id),
  };
}

export interface CodexRateLimitInfo {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: Date | null;
  planType: string | null;
}

/**
 * OpenAI stamps its own weekly-limit telemetry onto every token_count event
 * (`rate_limits.primary`). Not our gate — the configured denominator is — but
 * surfacing it in `status` lets users cross-check their budget against what
 * OpenAI will enforce on its side.
 */
export function parseCodexRateLimits(record: Json): CodexRateLimitInfo | null {
  const payload = object(record.payload);
  const rateLimits = object(payload.rate_limits);
  const primary = object(rateLimits.primary);
  if (!("used_percent" in primary)) return null;
  const used = Number(primary.used_percent);
  if (!Number.isFinite(used)) return null;
  const windowMinutes = Number(primary.window_minutes);
  const resetsAtEpoch = Number(primary.resets_at);
  return {
    usedPercent: used,
    windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : null,
    resetsAt:
      Number.isFinite(resetsAtEpoch) && resetsAtEpoch > 0
        ? new Date(resetsAtEpoch * 1000)
        : null,
    planType: text(rateLimits.plan_type),
  };
}
