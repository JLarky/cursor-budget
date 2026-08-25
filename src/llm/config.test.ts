import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  LlmConfigError,
  parseLlmConfig,
  serializeLlmConfig,
} from "./config.js";

test("defaults: both guards on at 80%, fail closed", () => {
  const config = parseLlmConfig({});
  assert.equal(config.claudeCode.enabled, true);
  assert.equal(config.claudeCode.weeklyBlockAtPercent, 80);
  assert.equal(config.claudeCode.rolling5hBlockAtPercent, 80);
  assert.equal(config.codex.weeklyBlockAtPercent, 80);
  assert.equal(config.codex.openAiWeeklyBlockAtPercent, null);
  assert.equal(config.enforcement.failClosed, true);
});

test("percent overrides parse and round-trip", () => {
  const customized = parseLlmConfig({
    claudeCode: { weeklyBlockAtPercent: 50 },
    codex: { openAiWeeklyBlockAtPercent: 3 },
    enforcement: { failClosed: false },
    excludeSessionIds: ["sess-1"],
  });
  assert.equal(customized.claudeCode.weeklyBlockAtPercent, 50);
  assert.equal(customized.codex.openAiWeeklyBlockAtPercent, 3);
  assert.equal(customized.enforcement.failClosed, false);

  const file = serializeLlmConfig(customized) as Record<string, any>;
  assert.deepEqual(file.claudeCode, { weeklyBlockAtPercent: 50 });
  assert.deepEqual(file.codex, { openAiWeeklyBlockAtPercent: 3 });
  assert.deepEqual(file.enforcement, { failClosed: false });
  assert.deepEqual(file.excludeSessionIds, ["sess-1"]);
  // Round-trip: parsing the serialized file yields the same config.
  assert.deepEqual(parseLlmConfig(file), customized);
});

test("serialize keeps only overrides; defaults serialize to an empty file", () => {
  assert.deepEqual(serializeLlmConfig(structuredClone(DEFAULT_CONFIG)), {});
});

test("invalid values are rejected with a clear error", () => {
  assert.throws(() => parseLlmConfig({ claudeCode: { weeklyBlockAtPercent: 120 } }), LlmConfigError);
  assert.throws(() => parseLlmConfig({ codex: { openAiWeeklyBlockAtPercent: -1 } }), LlmConfigError);
  // Unknown keys stay rejected (strict schema).
  assert.throws(() => parseLlmConfig({ budget: { denominator: {} } }), LlmConfigError);
  assert.throws(() => parseLlmConfig({ quota: {} }), LlmConfigError);
});
