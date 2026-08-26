import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tempHome } from "../test-home.js";
import { runCli } from "./cli-testkit.js";

test("codex-guard fails closed when config is invalid", async () => {
  const home = tempHome("llm-budget-cli-");
  mkdirSync(join(home, ".config", "llm-budget"), { recursive: true });
  writeFileSync(join(home, ".config", "llm-budget", "config.jsonc"), "{ not json");

  const result = await runCli(["codex-guard"], home);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /config/i);
});

test("codex-guard fails closed when Codex is not signed in", async () => {
  const home = tempHome("llm-budget-cli2-");
  const result = await runCli(["codex-guard"], home);
  assert.equal(result.code, 2);
});

test("codex-guard allows when failClosed is off", async () => {
  const home = tempHome("llm-budget-cli-open-");
  mkdirSync(join(home, ".config", "llm-budget"), { recursive: true });
  writeFileSync(
    join(home, ".config", "llm-budget", "config.jsonc"),
    '{ "enforcement": { "failClosed": false } }\n',
  );
  const result = await runCli(["codex-guard"], home);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
});

test("status covers all three agents", { timeout: 60_000 }, async () => {
  const home = tempHome("llm-budget-cli3-");
  const result = await runCli(["status"], home);
  assert.equal(result.code, 0);
  // `usage` is an alias of `status` and renders the same view.
  const alias = await runCli(["usage"], home);
  assert.equal(alias.code, 0);
  assert.match(alias.stdout, /Cursor Agent:/);
  assert.match(result.stdout, /Claude Code:/);
  assert.match(result.stdout, /Codex:/);
  assert.match(result.stdout, /Cursor Agent:/);
  assert.match(result.stdout, /Claude Code:\n  Hooks: not installed — run llm-budget claude install/);
  assert.match(result.stdout, /Codex:\n  Shim: not installed — run llm-budget codex shim-install/);
  assert.match(result.stdout, /Cursor Agent:\n  Hooks: not installed — run llm-budget cursor install/);
  // Every agent block carries its own escape-hatch state.
  assert.equal(result.stdout.split("Override:").length - 1 >= 3, true);
  assert.doesNotMatch(result.stdout, /\(claude\+codex\)/);
});

test("install registers every provider and status then reports installed", { timeout: 60_000 }, async () => {
  const home = tempHome("llm-budget-cli-install-");
  const before = await runCli(["status"], home);
  assert.equal(before.code, 0);
  assert.match(before.stdout, /Hooks: not installed — run llm-budget claude install/);
  assert.match(before.stdout, /Shim: not installed — run llm-budget codex shim-install/);
  assert.match(before.stdout, /Hooks: not installed — run llm-budget cursor install/);

  const installed = await runCli(["install"], home);
  assert.equal(installed.code, 0);
  assert.match(installed.stdout, /Installed llm-budget Claude Code hooks/);
  assert.match(installed.stdout, /Installed llm-budget Codex native hooks/);
  assert.match(installed.stdout, /Installed llm-budget Cursor Agent hooks/);

  const after = await runCli(["status"], home);
  assert.equal(after.code, 0);
  assert.match(after.stdout, /Claude Code:\n  Hooks: installed\n/);
  assert.match(after.stdout, /Codex:\n  Shim: not installed/);
  assert.match(after.stdout, /Codex:\n(?:.*\n)*  Hooks: installed\n/);
  assert.match(after.stdout, /Cursor Agent:\n  Hooks: installed\n/);
  assert.match(after.stdout, /Codex:\n  Shim: not installed/);
});

test("help lists three peer scopes and both override stores", async () => {
  const home = tempHome("llm-budget-cli-help-");
  const result = await runCli(["help"], home);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /llm-budget install/);
  assert.match(result.stdout, /llm-budget claude help/);
  assert.match(result.stdout, /llm-budget codex help/);
  assert.match(result.stdout, /llm-budget cursor help/);
  assert.match(result.stdout, /llm-budget override /);
  assert.match(result.stdout, /llm-budget cursor override /);
  assert.doesNotMatch(result.stdout, /Shared commands \(Claude Code and Codex\)/);
  assert.doesNotMatch(result.stdout, /the original Cursor/);
  assert.doesNotMatch(result.stdout, /\.cursor\/llm-budget/);
  assert.match(result.stdout, /~\/\.config\/llm-budget/);
});
