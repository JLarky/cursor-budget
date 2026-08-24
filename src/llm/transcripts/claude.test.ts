import assert from "node:assert/strict";
import test from "node:test";
import { parseClaudeUsage, updateClaudeContext } from "./claude.js";
import type { ParserContext } from "./types.js";

const EMPTY: ParserContext = { project: null, model: null, session: null };

test("parses Claude Code usage counters without double-counting caches", () => {
  const record = {
    type: "assistant",
    timestamp: "2026-07-23T12:34:56.000Z",
    sessionId: "session-private",
    cwd: "/work/project",
    uuid: "record-id",
    message: {
      id: "response-id",
      model: "claude-example",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
    },
  };

  const context = updateClaudeContext(record, EMPTY);
  assert.deepEqual(context, { project: "/work/project", model: "claude-example", session: "session-private" });

  const usage = parseClaudeUsage(record, context);
  assert.ok(usage);
  assert.deepEqual(usage.counters, {
    inputTokens: 10,
    outputTokens: 20,
    reasoningTokens: 0,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
  });
  assert.equal(usage.message, "response-id");
  assert.equal(usage.timestamp, "2026-07-23T12:34:56.000Z");
});

test("ignores records without token usage", () => {
  assert.equal(
    parseClaudeUsage({ type: "user", message: { content: "hello" } }, EMPTY),
    null,
  );
});

test("ignores all-zero usage records (streaming placeholders)", () => {
  const record = {
    type: "assistant",
    message: { id: "m1", model: "claude-x", usage: { input_tokens: 0, output_tokens: 0 } },
  };
  assert.equal(parseClaudeUsage(record, EMPTY), null);
});

test("threads context across lines for records lacking ids", () => {
  const withContext = parseClaudeUsage(
    {
      type: "assistant",
      message: { usage: { input_tokens: 5, output_tokens: 5 } },
    },
    { project: "/p", model: "claude-m", session: "s-1" },
  );
  assert.ok(withContext);
  assert.equal(withContext.session, "s-1");
  assert.equal(withContext.model, "claude-m");
});
