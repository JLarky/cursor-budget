import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "./config.js";
import { costUsd, resolveRate } from "./pricing.js";

test("glob matches claude-sonnet models", () => {
  const { rate, matched } = resolveRate("claude-sonnet-4-6", DEFAULT_CONFIG);
  assert.equal(matched, true);
  assert.equal(rate.inputPerMillion, 3);
});

test("unknown model uses fallback and is unmatched", () => {
  const { rate, matched } = resolveRate("mystery-model", DEFAULT_CONFIG);
  assert.equal(matched, false);
  assert.equal(rate.inputPerMillion, DEFAULT_CONFIG.fallback.inputPerMillion);
});

test("zero rates are treated as unconfigured", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.models["free-*"] = { inputPerMillion: 0, outputPerMillion: 0 };
  const { matched, rate } = resolveRate("free-bee", config);
  assert.equal(matched, false);
  assert.equal(rate.inputPerMillion, config.fallback.inputPerMillion);
});

test("cost uses per-million rates", () => {
  const usd = costUsd(
    { input: 1_000_000, output: 1_000_000, reasoning: 0 },
    { inputPerMillion: 3, outputPerMillion: 15 },
  );
  assert.equal(usd, 18);
});

test("most specific model pattern wins over broader globs", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.models = {
    "gpt-*": { inputPerMillion: 5, outputPerMillion: 15 },
    "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  };
  const { rate, matched } = resolveRate("gpt-4o", config);
  assert.equal(matched, true);
  assert.equal(rate.inputPerMillion, 2.5);
});
