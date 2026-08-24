import { sumTokenEventsByModel, type DatabaseSync } from "./db.js";
import { estimateCost, type ModelRate, type ResolvedRates } from "./pricing.js";
import type { DenominatorConfig } from "./config.js";
import type { TokenTotals } from "./db.js";

export interface WindowUsage {
  totals: TokenTotals;
  usd: number;
  /** Models seen in this window with no rate on file (costed at $0). */
  unpricedModels: string[];
  events: number;
}

const EMPTY_TOTALS: TokenTotals = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
};

/**
 * Sum one agent's events inside `[from, to]` into tokens and (when rates are
 * available) dollars. Unpriced models are reported rather than guessed.
 */
export function windowUsage(
  db: DatabaseSync,
  agent: string,
  from: Date,
  to: Date,
  rates: ResolvedRates | null,
  excludeSessionIds: string[] = [],
): WindowUsage {
  const byModel = sumTokenEventsByModel(db, agent, from, to, excludeSessionIds);
  const totals: TokenTotals = { ...EMPTY_TOTALS };
  let usd = 0;
  let events = 0;
  const unpricedModels: string[] = [];

  for (const entry of byModel) {
    events += entry.events;
    totals.inputTokens += entry.inputTokens;
    totals.outputTokens += entry.outputTokens;
    totals.reasoningTokens += entry.reasoningTokens;
    totals.cacheReadTokens += entry.cacheReadTokens;
    totals.cacheWriteTokens += entry.cacheWriteTokens;
    totals.totalTokens += entry.totalTokens;

    if (!rates) continue;
    const cost = estimateCost(
      entry.model,
      {
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        reasoningTokens: entry.reasoningTokens,
        cacheReadTokens: entry.cacheReadTokens,
        cacheWriteTokens: entry.cacheWriteTokens,
      },
      new Map<string, ModelRate>(rates.rates),
    );
    if (cost.missingRate) {
      unpricedModels.push(entry.model ?? "(unknown)");
    }
    usd += cost.usd;
  }

  return { totals, usd, unpricedModels, events };
}

export function denominatorDisplay(denominator: DenominatorConfig): string {
  return denominator.kind === "tokens"
    ? `${formatNumber(denominator.weeklyTokens)} tokens / week`
    : `${formatUsd(denominator.weeklyUsd)} / week`;
}

/** Amount without cadence suffix, for use inside sentences. */
export function denominatorAmount(denominator: DenominatorConfig): string {
  return denominator.kind === "tokens"
    ? `${formatNumber(denominator.weeklyTokens)} tokens`
    : formatUsd(denominator.weeklyUsd);
}

export function usageDisplay(
  used: Pick<WindowUsage, "totals" | "usd">,
  kind: DenominatorConfig["kind"],
): string {
  return kind === "tokens"
    ? `${formatNumber(used.totals.totalTokens)} tokens`
    : formatUsd(used.usd);
}

export function usedPctOf(
  denominator: DenominatorConfig,
  used: Pick<WindowUsage, "totals" | "usd">,
): number {
  if (denominator.kind === "tokens") {
    return (used.totals.totalTokens / denominator.weeklyTokens) * 100;
  }
  return (used.usd / denominator.weeklyUsd) * 100;
}

export function formatNumber(value: number): string {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function formatUsd(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "$?—";
  const abs = Math.abs(n);
  if (abs > 0 && abs < 0.01) {
    const trimmed = n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    return `$${trimmed}`;
  }
  return `$${n.toFixed(2)}`;
}
