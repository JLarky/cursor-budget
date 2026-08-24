import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLlmDb, sumTokenEventsByModel } from "../db.js";
import { collectAgentUsage, pathHash } from "./scanner.js";
import { CLAUDE_FIXTURE_JSONL, CODEX_FIXTURE_JSONL } from "./fixtures.js";

function makeHome(): { home: string; claudeFile: string; codexFile: string } {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-test-"));
  const claudeDir = join(home, ".claude", "projects", "work-project");
  const codexDir = join(home, ".codex", "archived_sessions", "2026", "08");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });

  const claudeFile = join(claudeDir, "session-1.jsonl");
  const codexFile = join(codexDir, "rollout-1.jsonl");
  writeFileSync(claudeFile, `${CLAUDE_FIXTURE_JSONL}\n`);
  writeFileSync(codexFile, `${CODEX_FIXTURE_JSONL}\n`);
  return { home, claudeFile, codexFile };
}

test("scans Claude and Codex fixture transcripts into token events", () => {
  const { home, claudeFile, codexFile } = makeHome();
  const db = openLlmDb(home);

  // Deterministic mtimes so fallback timestamps are stable.
  const t = new Date("2026-08-19T22:00:00.000Z").getTime();
  utimesSync(claudeFile, t / 1000, t / 1000);
  utimesSync(codexFile, t / 1000, t / 1000);

  const claudeStats = collectAgentUsage("claude", { home });
  assert.equal(claudeStats.totalFiles, 1);
  assert.equal(claudeStats.scannedFiles, 1);
  assert.equal(claudeStats.failedFiles, 0);
  assert.equal(claudeStats.malformedLines, 0);
  // msg_claude_1 appears twice (streaming growth); keyed dedupe keeps one row
  // with the fuller counters.
  assert.equal(claudeStats.addedEvents, 1);

  let rows = sumTokenEventsByModel(db, "claude", new Date(0), new Date("2027-01-01"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "claude-sonnet-5");
  assert.equal(rows[0].events, 1);
  // Fullest snapshot wins: input 20, output 210, cache read 900, cache write 500.
  assert.equal(rows[0].inputTokens, 20);
  assert.equal(rows[0].outputTokens, 210);
  assert.equal(rows[0].cacheReadTokens, 900);
  assert.equal(rows[0].cacheWriteTokens, 500);
  assert.equal(rows[0].totalTokens, 20 + 210 + 900 + 500);

  const codexStats = collectAgentUsage("codex", { home });
  assert.equal(codexStats.scannedFiles, 1);
  // Two distinct token_count events (per-call last_token_usage), the summary
  // line carries no usage.
  assert.equal(codexStats.addedEvents, 2);

  rows = sumTokenEventsByModel(db, "codex", new Date(0), new Date("2027-01-01"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "gpt-5.6-codex");
  // Event A: 15044-9984 input, 5 output; Event B: 11000-2016 input, 300-120
  // output + 120 reasoning; cache reads 9984+2016.
  assert.equal(rows[0].inputTokens, 5060 + 8984);
  assert.equal(rows[0].outputTokens, 5 + 180);
  assert.equal(rows[0].reasoningTokens, 120);
  assert.equal(rows[0].cacheReadTokens, 9984 + 2016);
});

test("checkpoints skip unchanged files until content changes", () => {
  const { home, claudeFile } = makeHome();
  collectAgentUsage("claude", { home });

  const stats = collectAgentUsage("claude", { home });
  assert.equal(stats.skippedFiles, 1);
  assert.equal(stats.scannedFiles, 0);

  // Touching content invalidates the checkpoint even at equal size+mtime? No:
  // same size AND mtime means skipped by design; grow the file instead.
  writeFileSync(claudeFile, `${CLAUDE_FIXTURE_JSONL}\n${CODEX_FIXTURE_JSONL}\n`);
  const after = collectAgentUsage("claude", { home });
  assert.equal(after.scannedFiles, 1);
});

test("malformed lines are counted, not fatal", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-test-"));
  const dir = join(home, ".claude", "projects", "p");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "bad.jsonl"),
    ["{not json}", JSON.stringify({ type: "assistant" }), ""].join("\n"),
  );
  const stats = collectAgentUsage("claude", { home });
  assert.equal(stats.scannedFiles, 1);
  // `{not json}` is malformed; the valid no-usage line is simply ignored.
  assert.equal(stats.malformedLines, 1);
  assert.equal(stats.addedEvents, 0);
});

test("pathHash is stable for identical paths", () => {
  assert.equal(pathHash("/a/b.jsonl"), pathHash("/a/b.jsonl"));
  assert.notEqual(pathHash("/a/b.jsonl"), pathHash("/a/c.jsonl"));
});

test("rolling window is half-open: an event exactly windowMs old ages out", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-test-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  const db = openLlmDb(home);
  const nowMs = new Date("2026-08-24T12:00:00.000Z").getTime();
  // One event exactly 5h old, one a millisecond newer.
  db.prepare(
    `INSERT INTO token_events (event_key, agent, session_id, ts, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, total_tokens)
     VALUES ('edge', 'codex', 's', ?, 100, 0, 0, 0, 0, 100)`,
  ).run(new Date(nowMs - 5 * 3_600_000).toISOString());
  db.prepare(
    `INSERT INTO token_events (event_key, agent, session_id, ts, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, total_tokens)
     VALUES ('inside', 'codex', 's', ?, 1, 0, 0, 0, 0, 1)`,
  ).run(new Date(nowMs - 5 * 3_600_000 + 1).toISOString());

  const from = new Date(nowMs - 5 * 3_600_000);
  const to = new Date(nowMs);
  const closed = sumTokenEventsByModel(db, "codex", from, to);
  assert.equal(closed[0]?.totalTokens, 101); // legacy [from,to] behavior
  const halfOpen = sumTokenEventsByModel(db, "codex", from, to, [], {
    fromInclusive: false,
  });
  assert.equal(halfOpen[0]?.totalTokens, 1); // boundary event aged out
});

test("unreadable roots are reported, missing roots stay silent", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-test-"));
  const locked = join(home, "locked-root");
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, "x.jsonl"), "{}\n");
  chmodSync(locked, 0o000);
  try {
    const stats = collectAgentUsage("claude", {
      home,
      // Second root does not exist at all: a normal fresh install.
      roots: [locked, join(home, "missing-root")],
    });
    assert.ok(stats.unreadableRoots && stats.unreadableRoots.length === 1);
    assert.match(stats.unreadableRoots![0]!, /locked-root/);
    assert.equal(stats.totalFiles, 0);
  } finally {
    chmodSync(locked, 0o755);
  }
});
