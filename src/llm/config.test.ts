import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  LlmConfigError,
  ensureLlmConfig,
  parseLlmConfig,
  renderLlmConfigFile,
} from "./config.js";
import { parseJsonc } from "../jsonc.js";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("defaults: both guards on at 80%, fail closed", () => {
  const config = parseLlmConfig({});
  assert.equal(config.claudeCode.enabled, true);
  assert.equal(config.claudeCode.weeklyBlockAtPercent, 80);
  assert.equal(config.claudeCode.rolling5hBlockAtPercent, 80);
  assert.equal(config.codex.weeklyBlockAtPercent, 80);
  assert.equal(config.codex.openAiWeeklyBlockAtPercent, null);
  assert.equal(config.enforcement.failClosed, true);
});

test("percent overrides parse and round-trip through the rendered file", () => {
  const customized = parseLlmConfig({
    claudeCode: { weeklyBlockAtPercent: 50 },
    codex: { openAiWeeklyBlockAtPercent: 3 },
    enforcement: { failClosed: false },
    excludeSessionIds: ["sess-1"],
  });
  assert.equal(customized.claudeCode.weeklyBlockAtPercent, 50);
  assert.equal(customized.codex.openAiWeeklyBlockAtPercent, 3);
  assert.equal(customized.enforcement.failClosed, false);

  // Round-trip: rendering the documented file and parsing it back yields the
  // same config.
  const rendered = renderLlmConfigFile(customized);
  assert.deepEqual(parseLlmConfig(parseJsonc(rendered)), customized);
});

test("invalid values are rejected with a clear error", () => {
  assert.throws(() => parseLlmConfig({ claudeCode: { weeklyBlockAtPercent: 120 } }), LlmConfigError);
  assert.throws(() => parseLlmConfig({ codex: { openAiWeeklyBlockAtPercent: -1 } }), LlmConfigError);
  // Unknown keys stay rejected (strict schema).
  assert.throws(() => parseLlmConfig({ budget: { denominator: {} } }), LlmConfigError);
  assert.doesNotThrow(() => parseLlmConfig({ quota: {}, cursor: { quota: {} } }));
});

test("jsonc: comments and trailing commas parse", () => {
  const config = parseLlmConfig(parseJsonc(`
    // llm-budget config
    {
      "claudeCode": {
        "weeklyBlockAtPercent": 50, // half
        /* block early on rolling too */
        "rolling5hBlockAtPercent": 30,
      },
      "codex": { "openAiWeeklyBlockAtPercent": 3, },
    }
  `));
  assert.equal(config.claudeCode.weeklyBlockAtPercent, 50);
  assert.equal(config.claudeCode.rolling5hBlockAtPercent, 30);
  assert.equal(config.codex.openAiWeeklyBlockAtPercent, 3);
});

test("first run writes a documented config.jsonc with every field", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-cfg-"));
  const config = ensureLlmConfig(home);
  assert.deepEqual(config, DEFAULT_CONFIG);
  const path = join(home, ".config", "llm-budget", "config.jsonc");
  assert.equal(existsSync(path), true);
  const text = readFileSync(path, "utf8");
  for (const field of [
    "enabled",
    "weeklyBlockAtPercent",
    "rolling5hBlockAtPercent",
    "openAiWeeklyBlockAtPercent",
    "failClosed",
    "excludeSessionIds",
  ]) {
    assert.match(text, new RegExp(`"${field}"`));
  }
  // The template round-trips to the defaults.
  assert.deepEqual(parseLlmConfig(parseJsonc(text)), DEFAULT_CONFIG);
});


test("rendered template is stable across a rewrite", () => {
  const customized = parseLlmConfig({ codex: { openAiWeeklyBlockAtPercent: 1 } });
  const once = renderLlmConfigFile(customized);
  assert.deepEqual(parseLlmConfig(parseJsonc(once)), customized);
});
