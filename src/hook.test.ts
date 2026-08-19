import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "./config.js";
import { handleHook } from "./hook.js";

test("invalid config.json denies enforce events instead of failing open", async () => {
  const home = mkdtempSync(join(tmpdir(), "cursor-budget-hook-"));
  const prevHome = process.env.HOME;
  try {
    mkdirSync(join(home, ".cursor", "llm-budget"), { recursive: true });
    writeFileSync(
      join(home, ".cursor", "llm-budget", "config.json"),
      `${JSON.stringify({
        models: {
          "broken-*": { input_per_million: 3, outputPerMillion: 15 },
        },
      })}\n`,
    );
    process.env.HOME = home;
    const response = await handleHook({
      hook_event_name: "preToolUse",
      conversation_id: "sess-bad-config",
    });
    assert.equal(response.permission, "deny");
    assert.equal(response.continue, false);
    assert.match(String(response.user_message), /failed to load config/);
    assert.match(String(response.user_message), /Session id: sess-bad-config/);
  } finally {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("invalid config.json still allows non-enforce record events", async () => {
  const home = mkdtempSync(join(tmpdir(), "cursor-budget-hook-rec-"));
  const prevHome = process.env.HOME;
  try {
    mkdirSync(join(home, ".cursor", "llm-budget"), { recursive: true });
    writeFileSync(join(home, ".cursor", "llm-budget", "config.json"), "{not-json");
    process.env.HOME = home;
    const response = await handleHook({
      hook_event_name: "afterAgentThought",
      conversation_id: "sess-record",
    });
    assert.equal(response.permission, "allow");
    assert.equal(response.continue, true);
  } finally {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("explicit config still enforces normally", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.limits.rollingHour.usd = 0;
  const response = await handleHook(
    {
      hook_event_name: "preToolUse",
      conversation_id: "sess-zero",
      model: "composer-1",
    },
    config,
  );
  assert.equal(response.permission, "deny");
  assert.match(String(response.user_message), /Session id: sess-zero/);
});
