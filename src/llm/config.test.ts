import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  LlmConfigError,
  parseLlmConfig,
  serializeLlmConfig,
} from "./config.js";

test("defaults: both guards on at 80%, token denominator", () => {
  const config = parseLlmConfig({});
  assert.deepEqual(config.budget.denominator, { kind: "tokens", weeklyTokens: 10_000_000 });
  assert.equal(config.claudeCode.enabled, true);
  assert.equal(config.claudeCode.weeklyBlockAtPercent, 80);
  assert.equal(config.claudeCode.rolling5hBlockAtPercent, 80);
  assert.equal(config.claudeCode.rollingWindowMs, DEFAULT_CONFIG.claudeCode.rollingWindowMs);
  assert.equal(config.codex.weeklyBlockAtPercent, 80);
  assert.equal(config.codex.openAiWeeklyBlockAtPercent, null);
  assert.equal(config.enforcement.failClosed, true);
});

test("usd denominator variant parses", () => {
  const config = parseLlmConfig({
    budget: { denominator: { kind: "usd", weeklyUsd: 35 } },
  });
  assert.deepEqual(config.budget.denominator, { kind: "usd", weeklyUsd: 35 });
});

test("invalid denominators are rejected with a clear error", () => {
  assert.throws(
    () => parseLlmConfig({ budget: { denominator: { kind: "tokens" } } }),
    LlmConfigError,
  );
  assert.throws(
    () => parseLlmConfig({ budget: { denominator: { kind: "usd", weeklyUsd: -5 } } }),
    LlmConfigError,
  );
  assert.throws(
    () => parseLlmConfig({ claudeCode: { weeklyBlockAtPercent: 120 } }),
    LlmConfigError,
  );
});

test("unknown keys are rejected (strict schema)", () => {
  assert.throws(() => parseLlmConfig({ quota: {} }), LlmConfigError);
});

test("codex OpenAI weekly percent gate parses and serializes only when set", () => {
  const customized = parseLlmConfig({ codex: { openAiWeeklyBlockAtPercent: 3 } });
  assert.equal(customized.codex.openAiWeeklyBlockAtPercent, 3);
  const file = serializeLlmConfig(customized) as Record<string, any>;
  assert.deepEqual(file.codex, { openAiWeeklyBlockAtPercent: 3 });
  assert.deepEqual(parseLlmConfig(file), customized);

  // Out-of-range values are rejected like every other percent.
  assert.throws(() => parseLlmConfig({ codex: { openAiWeeklyBlockAtPercent: -1 } }), LlmConfigError);
});

test("serialize keeps only overrides; round-trip is stable", () => {
  assert.deepEqual(serializeLlmConfig(DEFAULT_CONFIG), {});

  const customized = parseLlmConfig({
    budget: { denominator: { kind: "usd", weeklyUsd: 50 } },
    codex: { enabled: false },
  });
  const file = serializeLlmConfig(customized) as Record<string, any>;
  assert.deepEqual(file.budget.denominator, { kind: "usd", weeklyUsd: 50 });
  assert.deepEqual(file.codex, { enabled: false });
  // Round-trip: parsing the serialized file yields the same config.
  assert.deepEqual(parseLlmConfig(file), customized);
});
