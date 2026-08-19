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
    for (const [pattern, rate] of Object.entries(config.models)) {
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
