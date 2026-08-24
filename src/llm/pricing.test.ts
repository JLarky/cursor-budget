import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadRates, estimateCost, catalogToRates } from "./pricing.js";

test("loadRates merges rates.json with inline config overrides (config wins)", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-rates-"));
  const result = loadRates(
    {
      "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
    // No rates.json exists in a fresh temp home.
    home,
  );
  assert.equal(result.warnings.length, 0);
  const rate = result.rates.get("claude-sonnet-5");
  assert.ok(rate);
  assert.equal(rate.input, 3);
  assert.equal(rate.output, 15);
});

test("estimateCost prices each token bucket; missing models are flagged", () => {
  const rates = new Map([
    ["m1", { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }],
  ]);
  const cost = estimateCost(
    "m1",
    {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      reasoningTokens: 100_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 250_000,
    },
    rates,
  );
  // input 1 + output 2*0.5 + reasoning 2*0.1 + read 0.1*2 + write 0.2*0.25
  assert.equal(cost.usd, 1 + 1 + 0.2 + 0.2 + 0.05);
  assert.equal(cost.missingRate, false);

  const unknown = estimateCost("nope", { inputTokens: 5, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, rates);
  assert.equal(unknown.missingRate, true);
  assert.equal(unknown.usd, 0);
});

test("catalogToRates flattens a models.dev-style catalog", () => {
  const catalog = {
    anthropic: {
      models: {
        "claude-x": { cost: { input: 3, output: 15, cache_read: 0.3 } },
        broken: { cost: { output: 1 } }, // no input → skipped
      },
    },
    openai: {
      models: {
        "gpt-y": { cost: { input: 1.25, output: 10 } },
      },
    },
  };
  const { table, skipped } = catalogToRates(catalog);
  assert.equal(skipped, 1);
  assert.deepEqual(table["anthropic/claude-x"], { input: 3, output: 15, cacheRead: 0.3 });
  assert.deepEqual(table["openai/gpt-y"], { input: 1.25, output: 10 });
});
