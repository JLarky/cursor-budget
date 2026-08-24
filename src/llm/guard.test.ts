import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, type LlmConfig } from "./config.js";
import { openLlmDb } from "./db.js";
import { runGuard } from "./guard.js";
import type { ScanStats } from "./transcripts/scanner.js";

function config(overrides: {
  denominator?: LlmConfig["budget"]["denominator"];
  claudeEnabled?: boolean;
  codexEnabled?: boolean;
}): LlmConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  if (overrides.denominator) c.budget.denominator = overrides.denominator;
  if (overrides.claudeEnabled !== undefined) c.claudeCode.enabled = overrides.claudeEnabled;
  if (overrides.codexEnabled !== undefined) c.codex.enabled = overrides.codexEnabled;
  return c;
}

const ZERO: ScanStats = {
  totalFiles: 0,
  scannedFiles: 0,
  skippedFiles: 0,
  failedFiles: 0,
  malformedLines: 0,
  addedEvents: 0,
  updatedEvents: 0,
};

test("disabled agents short-circuit before any storage or transcript work", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-guard-"));
  let scanCalls = 0;
  const decision = runGuard("codex", config({ codexEnabled: false }), {
    home,
    scan: () => {
      scanCalls += 1;
      throw new Error("scan must not run for disabled agents");
    },
  });
  assert.equal(decision.allow, true);
  assert.equal(scanCalls, 0);
});

test("enabled agents still gate normally", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-guard2-"));
  // Seed codex usage above an 80% threshold of 100 tokens.
  const db = openLlmDb(home);
  db.prepare(
    `INSERT INTO token_events (
      event_key, agent, session_id, model, ts,
      input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, total_tokens
    ) VALUES ('g1', 'codex', 's', 'm', ?, 90, 10, 0, 0, 0, 100)`,
  ).run(new Date().toISOString());

  const decision = runGuard(
    "codex",
    config({ codexEnabled: true, denominator: { kind: "tokens", weeklyTokens: 100 } }),
    { home, now: new Date(), scan: () => ({ ...ZERO }) },
  );
  assert.equal(decision.allow, false);
  assert.equal(decision.evaluation.reasons[0]?.windowId, "codexWeekly");
});

test("unreadable transcript roots become usageUnknown under failClosed", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-guard3-"));
  const decision = runGuard("claude", config({}), {
    home,
    now: new Date(),
    scan: () => ({
      ...ZERO,
      unreadableRoots: ["/home/x/.claude/projects: EACCES: permission denied"],
    }),
  });
  assert.equal(decision.allow, false);
  const reason = decision.evaluation.reasons[0];
  assert.equal(reason?.windowId, "usageUnknown");
  assert.match(reason?.detail ?? "", /EACCES/);
});

test("partially unreadable transcripts become usageUnknown, not partial usage", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-guard4-"));
  const decision = runGuard("claude", config({}), {
    home,
    now: new Date(),
    scan: () => ({
      ...ZERO,
      totalFiles: 2,
      scannedFiles: 1,
      failedFiles: 1,
      failedFileNames: ["/home/x/.claude/projects/p/big.jsonl"],
    }),
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.evaluation.reasons[0]?.windowId, "usageUnknown");
  assert.match(decision.evaluation.reasons[0]?.detail ?? "", /1 transcript file\(s\) unreadable/);
});

test("USD denominator with unpriced models fails closed", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-guard5-"));
  const db = openLlmDb(home);
  db.prepare(
    `INSERT INTO token_events (
      event_key, agent, session_id, model, ts,
      input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, total_tokens
    ) VALUES ('u1', 'codex', 's', 'brand-new-model', ?, 5000, 0, 0, 0, 0, 5000)`,
  ).run(new Date().toISOString());

  const decision = runGuard(
    "codex",
    config({ denominator: { kind: "usd", weeklyUsd: 35 } }),
    { home, now: new Date(), scan: () => ({ ...ZERO }) },
  );
  // The model has no rate → measured spend is $0, which must read as unknown
  // rather than "plenty left".
  assert.equal(decision.allow, false);
  assert.equal(decision.evaluation.reasons[0]?.windowId, "usageUnknown");
  assert.match(decision.evaluation.reasons[0]?.detail ?? "", /brand-new-model/);

  // With rates on file for that model the guard allows again.
  const priced = runGuard(
    "codex",
    {
      ...config({ denominator: { kind: "usd", weeklyUsd: 35 } }),
      budget: {
        denominator: { kind: "usd", weeklyUsd: 35 },
        rates: { "brand-new-model": { input: 0.01, output: 0.03 } },
      },
    },
    { home, now: new Date(), scan: () => ({ ...ZERO }) },
  );
  assert.equal(priced.allow, true);
});
