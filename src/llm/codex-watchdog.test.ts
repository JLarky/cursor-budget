import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, type LlmConfig } from "./config.js";
import { openLlmDb, getState } from "./db.js";
import { runWatchdog } from "./codex-watchdog.js";

function blockedConfig(): LlmConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.budget.denominator = { kind: "tokens", weeklyTokens: 100 };
  return config;
}

function okConfig(): LlmConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.budget.denominator = { kind: "tokens", weeklyTokens: 1_000_000 };
  return config;
}

test("watchdog kills codex processes once per trip and latches until recovery", async () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-wd-"));
  let decideBlock = true;
  const killed: number[] = [];
  // Mimics defaultListCodexProcesses output: codex binaries only (vim etc.
  // are filtered by the ps parser), and never our own CLI process line.
  const processes = [
    { pid: 101, command: "/usr/local/bin/codex exec" },
    { pid: 102, command: "codex" },
    { pid: process.pid, command: `node ${process.argv[1]} watchdog` },
  ];

  const decide = () => ({
    allow: !decideBlock,
    evaluation: {
      allow: !decideBlock,
      reasons: [],
      overrideActive: false,
      excluded: false,
    },
    sessionId: "",
    config: decideBlock ? blockedConfig() : okConfig(),
  });

  // First pass: budget tripped → kill matching pids (never our own pid).
  const first = await runWatchdog({
    home,
    once: true,
    decide,
    listCodexProcesses: () => processes,
    kill: (pid) => {
      killed.push(pid);
      return true;
    },
    sleep: async () => {},
    log: () => {},
  });
  assert.equal(first?.blocked, true);
  assert.deepEqual(first?.killedPids.sort(), [101, 102]);
  assert.deepEqual(killed.sort(), [101, 102]);

  // Latch set: a second tripped pass must NOT kill again.
  const second = await runWatchdog({
    home,
    once: true,
    decide,
    listCodexProcesses: () => processes,
    kill: (pid) => {
      killed.push(pid);
      return true;
    },
    sleep: async () => {},
    log: () => {},
  });
  assert.equal(second?.blocked, true);
  assert.equal(second?.killedPids.length, 0);
  assert.equal(killed.length, 2);

  // Budget recovers (override/reset) → latch clears, re-armed.
  decideBlock = false;
  const third = await runWatchdog({
    home,
    once: true,
    decide,
    listCodexProcesses: () => processes,
    kill: (pid) => {
      killed.push(pid);
      return true;
    },
    sleep: async () => {},
    log: () => {},
  });
  assert.equal(third?.blocked, false);
  assert.equal(getState(openLlmDb(home), "codex_watchdog_trip"), "");

  // Trips again after recovery → kills again.
  decideBlock = true;
  const fourth = await runWatchdog({
    home,
    once: true,
    decide,
    listCodexProcesses: () => processes,
    kill: (pid) => {
      killed.push(pid);
      return true;
    },
    sleep: async () => {},
    log: () => {},
  });
  assert.equal(fourth?.killedPids.length, 2);
});
