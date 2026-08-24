export interface TokenCounters {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function countersTotal(counters: TokenCounters): number {
  return (
    counters.inputTokens +
    counters.outputTokens +
    counters.reasoningTokens +
    counters.cacheReadTokens +
    counters.cacheWriteTokens
  );
}

/**
 * A usage-bearing record reduced to what the budget guard needs. Mirrors the
 * prior art's parser output shape (counters + provenance) so the parsing rules
 * stay comparable.
 */
export interface ParsedUsage {
  counters: TokenCounters;
  /** ISO timestamp from the record; null lets the scanner fall back to mtime. */
  timestamp: string | null;
  session: string | null;
  model: string | null;
  project: string | null;
  /** Stable per-message id used for dedupe; null hashes counters instead. */
  message: string | null;
}

/** Context threaded across lines within one transcript file. */
export interface ParserContext {
  project: string | null;
  model: string | null;
  session: string | null;
}

export type Json = Record<string, unknown>;

export function object(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Coerce JSON numbers defensively; negative or non-numeric counts become 0. */
export function count(value: unknown): number {
  if (typeof value === "number") return Math.max(0, Math.trunc(value));
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
  }
  return 0;
}
