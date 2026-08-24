import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLlmDb, setState } from "./db.js";
import { DEFAULT_CONFIG, ensureLlmConfig, type LlmConfig } from "./config.js";
import {
  ClaudeHookInputError,
  CLAUDE_ENFORCE_EVENTS,
  handleClaudeHook,
  parseClaudeHookInput,
  type ClaudeHookEvent,
} from "./claude-hook.js";
import { installClaudeHooks, uninstallClaudeHooks } from "./claude-install.js";
import { collectAgentUsage } from "./transcripts/scanner.js";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "llm-budget-hook-"));
}

/** Seed a week's worth of claude usage directly into the db. */
function seedClaudeUsage(home: string, totalTokens: number): void {
  const db = openLlmDb(home);
  const perEvent = 1000;
  for (let i = 0; i < totalTokens / perEvent; i++) {
    db.prepare(
      `INSERT OR IGNORE INTO token_events (
        event_key, agent, session_id, model, ts,
        input_tokens, output_tokens, reasoning_tokens,
        cache_read_tokens, cache_write_tokens, total_tokens
      ) VALUES (?, 'claude', ?, 'claude-sonnet-5', ?, ?, ?, 0, 0, 0, ?)`,
    ).run(
      `seed-${i}`,
      "other-session",
      new Date(Date.now() - 60_000).toISOString(),
      perEvent - 100,
      100,
      perEvent,
    );
  }
}

function baseConfig(overrides: Partial<LlmConfig["claudeCode"]> = {}): LlmConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.budget.denominator = { kind: "tokens", weeklyTokens: 10_000 };
  Object.assign(config.claudeCode, overrides);
  return config;
}

test("enforce set covers the two registered hook events only", () => {
  assert.deepEqual([...CLAUDE_ENFORCE_EVENTS].sort(), ["PreToolUse", "UserPromptSubmit"]);
});

test("allows when usage is below both thresholds", () => {
  const home = makeHome();
  seedClaudeUsage(home, 5_000); // 50% of 10k
  const response = handleClaudeHook(
    { hook_event_name: "UserPromptSubmit", session_id: "s-1" },
    { home, config: baseConfig() },
  );
  assert.equal(response.block, false);
});

test("blocks UserPromptSubmit past the weekly threshold with escape hatches", () => {
  const home = makeHome();
  seedClaudeUsage(home, 9_500); // 95%
  const response = handleClaudeHook(
    { hook_event_name: "UserPromptSubmit", session_id: "sess-42" },
    { home, config: baseConfig() },
  );
  assert.equal(response.block, true);
  assert.ok(response.message);
  assert.match(response.message!, /Session id: sess-42/);
  assert.match(response.message!, /llm-budget override 30m/);
  assert.match(response.message!, /llm-budget except add sess-42/);
  // Weekly window is the one that trips here.
  assert.match(response.message!, /Weekly budget/);
});

test("rolling 5h window blocks independently of the weekly gate", () => {
  const home = makeHome();
  // 8,500 tokens landed 30 minutes ago: 85% of the 10k denominator.
  // Weekly blocks at 90% so it stays clear; rolling blocks at 80%.
  const config = baseConfig({ rollingWindowMs: 3_600_000 });
  config.claudeCode.weeklyBlockAtPercent = 90;
  const db = openLlmDb(home);
  db.prepare(
    `INSERT INTO token_events (
      event_key, agent, session_id, model, ts,
      input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, total_tokens
    ) VALUES ('r1', 'claude', 'other', 'm', ?, 0, 0, 0, 0, 0, 8_500)`,
  ).run(new Date(Date.now() - 30 * 60_000).toISOString());

  const response = handleClaudeHook(
    { hook_event_name: "UserPromptSubmit", session_id: "s" },
    { home, config },
  );
  assert.equal(response.block, true);
  assert.match(response.message!, /Rolling/);

  // The same usage is outside a 15-minute window: nothing trips then.
  const shortWindow = baseConfig({ rollingWindowMs: 900_000 });
  shortWindow.claudeCode.weeklyBlockAtPercent = 90;
  const allowed = handleClaudeHook(
    { hook_event_name: "UserPromptSubmit", session_id: "s" },
    { home, config: shortWindow },
  );
  assert.equal(allowed.block, false);
});

test("excluded sessions bypass every gate", () => {
  const home = makeHome();
  seedClaudeUsage(home, 10_000);
  const config = baseConfig();
  config.excludeSessionIds = ["special"];
  const response = handleClaudeHook(
    { hook_event_name: "PreToolUse", session_id: "special" },
    { home, config },
  );
  assert.equal(response.block, false);
});

test("override bypasses gates", () => {
  const home = makeHome();
  ensureLlmConfig(home);
  setState(openLlmDb(home), "override_until", new Date(Date.now() + 600_000).toISOString());
  seedClaudeUsage(home, 10_000);
  const response = handleClaudeHook(
    { hook_event_name: "UserPromptSubmit", session_id: "s" },
    { home, config: baseConfig() },
  );
  assert.equal(response.block, false);
});

test("broken config denies enforce events with a recoverable message", () => {
  const home = makeHome();
  mkdirSync(join(home, ".llm-budget"), { recursive: true });
  writeFileSync(join(home, ".llm-budget", "config.json"), "{ not json");
  const response = handleClaudeHook(
    { hook_event_name: "UserPromptSubmit", session_id: "s" },
    { home },
  );
  assert.equal(response.block, true);
  assert.match(response.message!, /failed to load config/);
  assert.match(response.message!, /Session id: s/);
});

test("non-enforce events never block", () => {
  const response = handleClaudeHook({ hook_event_name: "Stop", session_id: "s" }, {});
  assert.equal(response.block, false);
});

test("install merges into existing settings.json and uninstall removes only ours", () => {
  const home = makeHome();
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      theme: "dark",
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "/bin/other-tool" }] },
        ],
      },
    }),
  );

  installClaudeHooks(home);
  const afterInstall = JSON.parse(
    readFileSync(join(home, ".claude", "settings.json"), "utf8"),
  );
  assert.equal(afterInstall.theme, "dark");
  // Other tools' entries survive.
  assert.equal(afterInstall.hooks.PreToolUse.length, 2);
  assert.equal(
    afterInstall.hooks.PreToolUse[0].hooks[0].command,
    "/bin/other-tool",
  );
  assert.ok(Array.isArray(afterInstall.hooks.UserPromptSubmit));

  // Idempotent.
  installClaudeHooks(home);
  const second = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(second.hooks.PreToolUse.length, 2);

  uninstallClaudeHooks(home);
  const afterUninstall = JSON.parse(
    readFileSync(join(home, ".claude", "settings.json"), "utf8"),
  );
  assert.equal(afterUninstall.theme, "dark");
  assert.equal(afterUninstall.hooks.PreToolUse.length, 1);
  assert.equal(afterUninstall.hooks.PreToolUse[0].matcher, "Bash");
  assert.equal(afterUninstall.hooks.UserPromptSubmit, undefined);
});

test("hook event without session id still formats a usable block message", () => {
  const home = makeHome();
  seedClaudeUsage(home, 10_000);
  const event: ClaudeHookEvent = { hook_event_name: "UserPromptSubmit" };
  const response = handleClaudeHook(event, { home, config: baseConfig() });
  assert.equal(response.block, true);
  assert.match(response.message!, /Session id: unknown/);
});

test("malformed or empty hook input fails closed", () => {
  // Claude Code always pipes JSON; empty or garbage stdin means something
  // upstream is broken and must not read as "no event".
  assert.throws(() => parseClaudeHookInput(""), ClaudeHookInputError);
  assert.throws(() => parseClaudeHookInput("   \n"), ClaudeHookInputError);
  assert.throws(() => parseClaudeHookInput('{"hook_event_name":"UserPromptSubmit"'), ClaudeHookInputError);
  assert.throws(() => parseClaudeHookInput("not json at all"), ClaudeHookInputError);

  const ok = parseClaudeHookInput('{"hook_event_name":"Stop","session_id":"s"}');
  assert.equal(ok.hook_event_name, "Stop");
});
