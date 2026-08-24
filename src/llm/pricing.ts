import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RateTable } from "./config.js";
export type { ModelRate } from "./config.js";
import type { ModelRate } from "./config.js";
import { ratesPath } from "./paths.js";
import type { TokenCounters } from "./transcripts/types.js";

export interface ResolvedRates {
  rates: Map<string, ModelRate>;
  warnings: string[];
}

function normalizeModelRate(raw: unknown, label: string, warnings: string[]): ModelRate | null {
  if (typeof raw !== "object" || raw === null) {
    warnings.push(`rates: skipping ${label} (not an object)`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const input = Number(obj.input);
  const output = Number(obj.output);
  if (!Number.isFinite(input) || !Number.isFinite(output)) {
    warnings.push(`rates: skipping ${label} (input/output must be numbers)`);
    return null;
  }
  const cacheRead = Number(obj.cacheRead ?? obj.cache_read);
  const cacheWrite = Number(obj.cacheWrite ?? obj.cache_write);
  const reasoning = Number(obj.reasoning);
  return {
    input,
    output,
    ...(Number.isFinite(cacheRead) ? { cacheRead } : {}),
    ...(Number.isFinite(cacheWrite) ? { cacheWrite } : {}),
    ...(Number.isFinite(reasoning) ? { reasoning } : {}),
  };
}

/**
 * Merge the on-disk rate table (`rates.json`, written by `import-rates`) with
 * inline `budget.rates` overrides; config wins. Missing file is not an error —
 * unpriced models simply report as missing at estimate time.
 */
export function loadRates(
  configRates: RateTable | undefined,
  home?: string,
): ResolvedRates {
  const warnings: string[] = [];
  const rates = new Map<string, ModelRate>();

  const path = ratesPath(home);
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        for (const [model, raw] of Object.entries(parsed as Record<string, unknown>)) {
          const rate = normalizeModelRate(raw, model, warnings);
          if (rate) rates.set(model, rate);
        }
      } else {
        warnings.push("rates.json: expected an object keyed by model");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`rates.json unreadable (${detail}); continuing without it`);
    }
  }

  for (const [model, raw] of Object.entries(configRates ?? {})) {
    const rate = normalizeModelRate(raw, `config.budget.rates.${model}`, warnings);
    if (rate) rates.set(model, rate);
  }

  return { rates, warnings };
}

export interface CostEstimate {
  usd: number;
  /** True when the model has no rate and the cost was counted as $0. */
  missingRate: boolean;
}

/** $/1M-token estimate over one bucket of counters. */
export function estimateCost(
  model: string | null | undefined,
  counters: TokenCounters,
  rates: Map<string, ModelRate>,
): CostEstimate {
  if (!model || !rates.has(model)) return { usd: 0, missingRate: true };
  const rate = rates.get(model)!;
  // Reasoning tokens bill at output price unless overridden.
  const reasoningRate = rate.reasoning ?? rate.output;
  const usd =
    (counters.inputTokens * rate.input +
      counters.outputTokens * rate.output +
      counters.reasoningTokens * reasoningRate +
      counters.cacheReadTokens * (rate.cacheRead ?? 0) +
      counters.cacheWriteTokens * (rate.cacheWrite ?? 0)) /
    1_000_000;
  return { usd, missingRate: false };
}

/**
 * Flatten a models.dev-style catalog (as cached by token-tracker's
 * pricing-cache.json or fetched from https://models.dev/api.json) into our
 * rate table.
 *
 * Transcript parsers store bare model ids (`claude-sonnet-5`,
 * `gpt-5.6-codex`), so each entry is stored twice: as `provider/model` and as
 * a bare `model` alias. When two providers ship the same model id, the
 * alphabetically-first provider wins the bare alias — deterministic, and
 * collisions are rare. Exact keys always beat aliases in the merge order
 * because `loadRates` applies config overrides last.
 */
export function catalogToRates(catalog: unknown): { table: RateTable; skipped: number } {
  const table: RateTable = {};
  let skipped = 0;
  const providers =
    typeof catalog === "object" && catalog !== null
      ? (catalog as Record<string, Record<string, unknown>>)
      : {};
  for (const providerId of Object.keys(providers).sort()) {
    const rawModels: unknown = providers[providerId]?.models;
    if (typeof rawModels !== "object" || rawModels === null) continue;
    const models = rawModels as Record<string, { cost?: unknown }>;
    for (const modelId of Object.keys(models).sort()) {
      const cost = models[modelId]?.cost;
      if (typeof cost !== "object" || cost === null) {
        skipped += 1;
        continue;
      }
      const warnings: string[] = [];
      const rate = normalizeModelRate(cost, `${providerId}/${modelId}`, warnings);
      if (!rate) {
        skipped += 1;
        continue;
      }
      table[`${providerId}/${modelId}`] = rate;
      if (!(modelId in table)) table[modelId] = rate;
    }
  }
  return { table, skipped };
}

export function writeRatesFile(table: RateTable, home?: string): void {
  const path = ratesPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(table, null, 2)}\n`);
}
