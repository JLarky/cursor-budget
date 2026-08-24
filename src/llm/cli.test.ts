import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "./cli-testkit.js";

test("codex-guard fails closed when config is invalid", async () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-cli-"));
  mkdirSync(join(home, ".llm-budget"), { recursive: true });
  writeFileSync(join(home, ".llm-budget", "config.json"), "{ not json");

  const result = await runCli(["codex-guard"], home);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /config/i);
});

test("codex-guard allows silently under a valid config", async () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-cli2-"));
  const result = await runCli(["codex-guard"], home);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
});

test("status covers all three agents", { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-cli3-"));
  const result = await runCli(["status"], home);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Claude Code:/);
  assert.match(result.stdout, /Codex:/);
  assert.match(result.stdout, /Cursor Agent:/);
  // Scoped escape hatches stay unambiguous.
  assert.match(result.stdout, /\(claude\+codex\)/);
});
