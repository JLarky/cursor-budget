import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { tempHome } from "../test-home.js";
import { setCursorOverride, openDb } from "../db/client.js";
import { openLlmDb, setState } from "./db.js";
import { runCli } from "./cli-testkit.js";

test("status covers all four agents", { timeout: 60_000 }, async () => {
  const home = tempHome("llm-budget-cli4-");
  const result = await runCli(["status"], home);
  assert.equal(result.code, 0);
  // `usage` is an alias of `status` and renders the same view.
  const alias = await runCli(["usage"], home);
  assert.equal(alias.code, 0);
  assert.match(alias.stdout, /Cursor Agent:/);
  assert.match(result.stdout, /Claude Code:/);
  assert.match(result.stdout, /Codex:/);
  assert.match(result.stdout, /Cursor Agent:/);
  assert.match(result.stdout, /Grok CLI:/);
  assert.match(result.stdout, /Claude Code:\n  Hooks: not installed — run llm-budget claude install/);
  assert.match(result.stdout, /Cursor Agent:\n  Hooks: not installed — run llm-budget cursor install/);
  assert.match(result.stdout, /Grok CLI:\n  Hooks: not installed — run llm-budget grok install/);
  assert.match(result.stdout, /Weekly: unavailable/);
  // Every agent block carries its own escape-hatch state.
  assert.equal(result.stdout.split("Override:").length - 1 >= 4, true);
  assert.doesNotMatch(result.stdout, /\(claude\+codex\)/);
});

test("expired Cursor override is not shown as active in combined status", { timeout: 60_000 }, async () => {
  const home = tempHome("llm-budget-cli-ovr-");
  try {
    setCursorOverride(openDb(home), new Date(Date.now() - 60_000).toISOString());
    const result = await runCli(["status"], home);
    assert.equal(result.code, 0);
    const cursorBlock = result.stdout.split("Cursor Agent:")[1] ?? "";
    assert.match(cursorBlock, /Override: none/);
    assert.doesNotMatch(cursorBlock, /Override: until/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("expired Claude/Codex override is not shown as active in combined status", { timeout: 60_000 }, async () => {
  const home = tempHome("llm-budget-cli-llm-ovr-");
  try {
    setState(openLlmDb(home), "override_until", new Date(Date.now() - 60_000).toISOString());
    const result = await runCli(["status"], home);
    assert.equal(result.code, 0);
    const claudeBlock = result.stdout.split("Claude Code:")[1]?.split("Codex:")[0] ?? "";
    const codexBlock = result.stdout.split("Codex:")[1]?.split("Cursor Agent:")[0] ?? "";
    assert.match(claudeBlock, /Override: none/);
    assert.match(codexBlock, /Override: none/);
    assert.doesNotMatch(claudeBlock, /Override: until/);
    assert.doesNotMatch(codexBlock, /Override: until/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install registers every provider and status then reports installed", { timeout: 60_000 }, async () => {
  const home = tempHome("llm-budget-cli-install-");
  const before = await runCli(["status"], home);
  assert.equal(before.code, 0);
  assert.match(before.stdout, /Hooks: not installed — run llm-budget claude install/);
  assert.match(before.stdout, /Hooks: not installed — run llm-budget cursor install/);
  assert.match(before.stdout, /Hooks: not installed — run llm-budget grok install/);

  const installed = await runCli(["install"], home);
  assert.equal(installed.code, 0);
  assert.match(installed.stdout, /Installed llm-budget Claude Code hooks/);
  assert.match(installed.stdout, /Installed llm-budget Codex native hooks/);
  assert.match(installed.stdout, /Installed llm-budget Cursor Agent hooks/);
  assert.match(installed.stdout, /Installed llm-budget Grok CLI hooks/);

  const after = await runCli(["status"], home);
  assert.equal(after.code, 0);
  assert.match(after.stdout, /Claude Code:\n  Hooks: installed\n/);
  assert.match(after.stdout, /Codex:\n(?:.*\n)*  Hooks: installed\n/);
  assert.match(after.stdout, /Cursor Agent:\n  Hooks: installed\n/);
  assert.match(after.stdout, /Grok CLI:\n  Hooks: installed\n/);
});

test("grok install writes its own hooks file", { timeout: 60_000 }, async () => {
  const home = tempHome("llm-budget-cli-grok-install-");
  const result = await runCli(["grok", "install"], home);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Installed llm-budget Grok CLI hooks/);
  assert.match(result.stdout, /\.grok\/hooks\/llm-budget\.json/);
});

test("grok status is reachable on its own and matches the combined view", { timeout: 60_000 }, async () => {
  const home = tempHome("llm-budget-cli-grok-status-");
  const result = await runCli(["grok", "status"], home);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^llm-budget\n/);
  assert.match(result.stdout, /Grok CLI:/);
  assert.match(result.stdout, /Weekly: unavailable/);
});

test("help lists four peer scopes and every override store", async () => {
  const home = tempHome("llm-budget-cli-help-");
  const result = await runCli(["help"], home);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /llm-budget install/);
  assert.match(result.stdout, /llm-budget claude help/);
  assert.match(result.stdout, /llm-budget codex help/);
  assert.match(result.stdout, /llm-budget cursor help/);
  assert.match(result.stdout, /llm-budget grok help/);
  assert.match(result.stdout, /llm-budget override /);
  assert.match(result.stdout, /llm-budget cursor override /);
  assert.match(result.stdout, /llm-budget grok override /);
  assert.doesNotMatch(result.stdout, /Shared commands \(Claude Code and Codex\)/);
  assert.doesNotMatch(result.stdout, /the original Cursor/);
  assert.doesNotMatch(result.stdout, /\.cursor\/llm-budget/);
  assert.match(result.stdout, /~\/\.config\/llm-budget/);
});

test("grok help is its own subcommand", async () => {
  const home = tempHome("llm-budget-cli-grok-help-");
  const result = await runCli(["grok", "help"], home);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /llm-budget grok install/);
  assert.match(result.stdout, /llm-budget grok hook/);
});
