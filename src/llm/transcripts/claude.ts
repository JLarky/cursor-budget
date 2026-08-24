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
 * Parsing rules mirror the prior art (fork-token-tracker's Claude parser,
 * version "claude-v2"): Anthropic reports cache reads/creation as separate
 * fields that do NOT overlap `input_tokens`, and reasoning (if ever present)
 * is a subset of output.
 */
export const CLAUDE_PARSER_VERSION = "claude-v2";

export function updateClaudeContext(record: Json, context: ParserContext): ParserContext {
  const message = object(record.message);
  return {
    project: text(record.cwd) ?? text(record.projectPath) ?? context.project,
    model: text(message.model) ?? text(record.model) ?? context.model,
    session: text(record.sessionId) ?? text(record.session_id) ?? context.session,
  };
}

export function parseClaudeUsage(record: Json, context: ParserContext): ParsedUsage | null {
  const message = object(record.message);
  const usage = object(message.usage);

  if (Object.keys(usage).length === 0) return null;

  const counters: TokenCounters = {
    inputTokens: count(usage.input_tokens),
    reasoningTokens: count(usage.reasoning_tokens),
    outputTokens: Math.max(0, count(usage.output_tokens) - count(usage.reasoning_tokens)),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
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
    timestamp:
      text(record.timestamp) ?? text(record.created_at) ?? text(message.timestamp) ?? null,
    session: text(record.sessionId) ?? text(record.session_id) ?? context.session,
    model: text(message.model) ?? text(record.model) ?? context.model,
    project: text(record.cwd) ?? text(record.projectPath) ?? context.project,
    message: text(message.id) ?? text(record.uuid),
  };
}
