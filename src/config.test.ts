import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError, DEFAULT_CONFIG, parseConfig } from "./config.js";

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

test("accepts valid partial limits", () => {
  const config = parseConfig({
    limits: {
      rollingHour: { usd: 1, tokens: null },
    },
  });
  assert.equal(config.limits.rollingHour.usd, 1);
  assert.equal(config.limits.calendarDay.usd, null);
});
