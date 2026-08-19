import type { Config, ModelRate } from "./config.js";

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function resolveRate(
  model: string | undefined,
  config: Config,
): { rate: ModelRate; matched: boolean } {
  const name = model?.trim() ?? "";
  if (name) {
    const patterns = Object.entries(config.models).sort(
      ([a], [b]) => patternSpecificity(b) - patternSpecificity(a),
    );
    for (const [pattern, rate] of patterns) {
      if (globToRegExp(pattern).test(name)) {
        const unconfigured = rate.inputPerMillion === 0 && rate.outputPerMillion === 0;
        if (unconfigured) {
          return { rate: config.fallback, matched: false };
        }
        return { rate, matched: true };
      }
    }
  }
  return { rate: config.fallback, matched: false };
}

/** Prefer longer literal prefixes and fewer wildcards (e.g. gpt-4o over gpt-*). */
export function patternSpecificity(pattern: string): number {
  const stars = (pattern.match(/\*/g) ?? []).length;
  const literals = pattern.replace(/\*/g, "").length;
  return literals * 1000 - stars;
}

export function costUsd(
  tokens: { input: number; output: number; reasoning: number },
  rate: ModelRate,
): number {
  const reasoningRate = rate.reasoningPerMillion ?? rate.outputPerMillion;
  return (
    (tokens.input / 1_000_000) * rate.inputPerMillion +
    (tokens.output / 1_000_000) * rate.outputPerMillion +
    (tokens.reasoning / 1_000_000) * reasoningRate
  );
}
