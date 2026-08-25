import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConfigError,
  DEFAULT_CONFIG,
  ensureConfig,
  parseConfig,
  writeConfig,
} from "./config.js";
import { configPath } from "./paths.js";
import { stripJsoncComments } from "./jsonc.js";

test("empty object uses defaults", () => {
  const config = parseConfig({});
  assert.deepEqual(config.quota, DEFAULT_CONFIG.quota);
  assert.deepEqual(config.rateLimit, DEFAULT_CONFIG.rateLimit);
  assert.deepEqual(config.warnings, DEFAULT_CONFIG.warnings);
});

test("rejects unknown top-level fields (including removed legacy keys)", () => {
  assert.throws(
    () => parseConfig({ limits: { rollingHour: { usd: 1 } } }),
    (error: unknown) => error instanceof ConfigError && /Invalid config\.json/.test(error.message),
  );
});

test("allows $schema and _comment annotations", () => {
  const config = parseConfig({
    $schema: "https://example.com/llm-budget.schema.json",
    _comment: "quota caps",
    quota: { cursorModelsBlockAtPercent: 80 },
  });
  assert.equal(config.quota.cursorModelsBlockAtPercent, 80);
  assert.equal(config.quota.otherModelsBlockAtPercent, 90);
});

test("rejects percent thresholds outside 0–100", () => {
  assert.throws(
    () => parseConfig({ quota: { cursorModelsBlockAtPercent: 101 } }),
    ConfigError,
  );
  assert.throws(
    () => parseConfig({ quota: { otherModelsBlockAtPercent: -1 } }),
    ConfigError,
  );
});

test("rejects warnings outside 0–1", () => {
  assert.throws(() => parseConfig({ warnings: [1.5] }), ConfigError);
});

test("rejects string quota values", () => {
  assert.throws(
    () =>
      parseConfig({
        quota: { cursorModelsBlockAtPercent: "90" },
      }),
    ConfigError,
  );
});

test("rejects unknown nested keys", () => {
  assert.throws(
    () =>
      parseConfig({
        quota: { cursorModelsBlockAtPercent: 90, extra: true },
      }),
    ConfigError,
  );
});

test("accepts null totalBlockAtPercent and rate limit", () => {
  const config = parseConfig({
    quota: { totalBlockAtPercent: null },
    rateLimit: { maxEventsPerHour: null },
  });
  assert.equal(config.quota.totalBlockAtPercent, null);
  assert.equal(config.rateLimit.maxEventsPerHour, null);
});

test("ensureConfig treats whitespace-only file as empty object", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-ws-"));
  try {
    ensureConfig(home);
    writeFileSync(configPath(home), "  \n\t\n");
    const config = ensureConfig(home);
    assert.deepEqual(config.quota, DEFAULT_CONFIG.quota);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensureConfig errors include config path and recovery hint", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-err-"));
  try {
    ensureConfig(home);
    const path = configPath(home);
    writeFileSync(path, "{not-json");
    assert.throws(
      () => ensureConfig(home),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes(path) &&
        /Delete this file to regenerate defaults/.test(error.message),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});


test("writeConfig keeps the documented template after mutation", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-write-"));
  try {
    const config = ensureConfig(home);
    config.excludeConversationIds = ["sess-1"];
    writeConfig(config, home);
    // The rewritten file is still the full documented template and parses
    // back to exactly the written config.
    const text = readFileSync(configPath(home), "utf8");
    assert.match(text, /llm-budget configuration/);
    assert.match(text, /"excludeConversationIds": \["sess-1"\]/);
    const reparsed = parseConfig(JSON.parse(stripJsoncComments(text)));
    assert.deepEqual(reparsed.excludeConversationIds, ["sess-1"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
