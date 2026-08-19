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
  serializeConfig,
  writeConfig,
} from "./config.js";
import { configPath } from "./paths.js";

test("empty object uses defaults", () => {
  const config = parseConfig({});
  assert.deepEqual(config.limits, DEFAULT_CONFIG.limits);
  assert.equal(config.accounting.safetyMultiplier, 2);
});

test("rejects unknown top-level fields", () => {
  assert.throws(
    () => parseConfig({ safetyMultiplier: 3 }),
    (error: unknown) => error instanceof ConfigError && /Invalid config\.json/.test(error.message),
  );
});

test("allows $schema and _comment annotations", () => {
  const config = parseConfig({
    $schema: "https://example.com/cursor-budget.schema.json",
    _comment: "hourly cap",
    limits: { rollingHour: { usd: 1 } },
  });
  assert.equal(config.limits.rollingHour.usd, 1);
  assert.equal(config.limits.rollingHour.tokens, null);
});

test("rejects typo model rate keys", () => {
  assert.throws(
    () =>
      parseConfig({
        models: {
          "claude-sonnet-*": { input_per_million: 3, outputPerMillion: 15 },
        },
      }),
    ConfigError,
  );
});

test("rejects string limits", () => {
  assert.throws(
    () =>
      parseConfig({
        limits: { rollingHour: { usd: "5", tokens: null } },
      }),
    ConfigError,
  );
});

test("rejects unknown nested keys", () => {
  assert.throws(
    () =>
      parseConfig({
        accounting: { provider: "local", safetyMultiplier: 2, extra: true },
      }),
    ConfigError,
  );
});

test("merges user models onto defaults", () => {
  const config = parseConfig({
    models: {
      "my-local-*": { inputPerMillion: 1, outputPerMillion: 2 },
    },
  });
  assert.equal(config.models["my-local-*"]?.inputPerMillion, 1);
  assert.equal(config.models["claude-sonnet-*"]?.inputPerMillion, 3);
});

test("accepts one-key partial limits", () => {
  const config = parseConfig({
    limits: {
      rollingHour: { usd: 5 },
      calendarDay: { tokens: 200_000 },
    },
  });
  assert.equal(config.limits.rollingHour.usd, 5);
  assert.equal(config.limits.rollingHour.tokens, null);
  assert.equal(config.limits.calendarDay.usd, null);
  assert.equal(config.limits.calendarDay.tokens, 200_000);
});

test("accepts partial fallback rates", () => {
  const config = parseConfig({
    fallback: { inputPerMillion: 9 },
  });
  assert.equal(config.fallback.inputPerMillion, 9);
  assert.equal(config.fallback.outputPerMillion, DEFAULT_CONFIG.fallback.outputPerMillion);
});

test("ensureConfig treats whitespace-only file as empty object", () => {
  const home = mkdtempSync(join(tmpdir(), "cursor-budget-ws-"));
  try {
    ensureConfig(home);
    writeFileSync(configPath(home), "  \n\t\n");
    const config = ensureConfig(home);
    assert.deepEqual(config.limits, DEFAULT_CONFIG.limits);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensureConfig errors include config path and recovery hint", () => {
  const home = mkdtempSync(join(tmpdir(), "cursor-budget-err-"));
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

test("serializeConfig omits default model rates", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.limits.rollingHour.usd = 1;
  config.excludeConversationIds = ["abc"];
  const file = serializeConfig(config);
  assert.deepEqual(file.limits, { rollingHour: { usd: 1 } });
  assert.deepEqual(file.excludeConversationIds, ["abc"]);
  assert.equal("models" in file, false);
});

test("writeConfig stays compact after except-style mutation", () => {
  const home = mkdtempSync(join(tmpdir(), "cursor-budget-write-"));
  try {
    const config = ensureConfig(home);
    config.excludeConversationIds = ["sess-1"];
    writeConfig(config, home);
    const raw = JSON.parse(readFileSync(configPath(home), "utf8")) as Record<string, unknown>;
    assert.deepEqual(raw, { excludeConversationIds: ["sess-1"] });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
