import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, type LlmConfig } from "./config.js";
import { openLlmDb, getState } from "./db.js";
import { runWatchdog } from "./codex-watchdog.js";

// Decisions are injected, so one config serves both tripped and clear passes.
function anyConfig(): LlmConfig {
  return structuredClone(DEFAULT_CONFIG);
}

test("watchdog kills codex processes on every tripped pass, notifies once", async () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-wd-"));
  let decideBlock = true;
  const killed: number[] = [];
  const notified: string[] = [];
  const logs: string[] = [];
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
    config: anyConfig(),
  });

  const runPass = () =>
    runWatchdog({
      home,
      once: true,
      decide,
      listCodexProcesses: () => processes,
      kill: (pid) => {
        killed.push(pid);
        return true;
      },
      sleep: async () => {},
      log: (line) => logs.push(line),
      notifyFn: (title, body) => notified.push(`${title}: ${body}`),
    });

  // First pass: budget tripped → kill matching pids (never our own pid).
  const first = await runPass();
  assert.equal(first?.blocked, true);
  assert.deepEqual(first?.killedPids.sort(), [101, 102]);
  assert.equal(notified.length, 1);

  // Latch is set, but enforcement continues: a codex process that appeared
  // later (or survived the first SIGTERM) is killed again on this pass.
  processes.push({ pid: 104, command: "/opt/bin/codex" });
  const second = await runPass();
  assert.equal(second?.blocked, true);
  assert.deepEqual(second?.killedPids.sort(), [101, 102, 104]);
  // Notification fires only on the transition, not every poll.
  assert.equal(notified.length, 1);

  // Budget recovers (override/reset) → latch clears, re-armed.
  decideBlock = false;
  const third = await runPass();
  assert.equal(third?.blocked, false);
  assert.equal(getState(openLlmDb(home), "codex_watchdog_trip"), "");

  // Trips again after recovery → notifies once more.
  decideBlock = true;
  const fourth = await runPass();
  assert.equal(fourth?.killedPids.length, 3);
  assert.equal(notified.length, 2);
});

test("watchdog fails closed when config is unreadable", async () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-wd-badcfg-"));
  mkdirSync(join(home, ".llm-budget"), { recursive: true });
  writeFileSync(join(home, ".llm-budget", "config.jsonc"), "{ not json");
  const killed: number[] = [];
  const notified: string[] = [];

  const result = await runWatchdog({
    home,
    once: true,
    listCodexProcesses: () => [{ pid: 201, command: "codex" }],
    kill: (pid) => {
      killed.push(pid);
      return true;
    },
    sleep: async () => {},
    notifyFn: (_t, b) => notified.push(b),
  });
  assert.equal(result?.blocked, true);
  assert.deepEqual(result?.killedPids, [201]);
  assert.match(notified[0] ?? "", /fail-closed|config unreadable/i);
});
