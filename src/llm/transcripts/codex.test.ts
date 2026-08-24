import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCodexRateLimits,
  parseCodexUsage,
  updateCodexContext,
} from "./codex.js";
import type { ParserContext } from "./types.js";

const EMPTY: ParserContext = { project: null, model: null, session: null };

test("separates cached input and reasoning without double-counting", () => {
  const record = {
    type: "event_msg",
    timestamp: "2026-07-23T12:34:56.000Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          output_tokens: 50,
          reasoning_output_tokens: 20,
        },
      },
    },
  };

  const usage = parseCodexUsage(record, EMPTY);
  assert.ok(usage);
  // cached_input is a subset of input; reasoning a subset of output.
  assert.deepEqual(usage.counters, {
    inputTokens: 60,
    outputTokens: 30,
    reasoningTokens: 20,
    cacheReadTokens: 40,
    cacheWriteTokens: 0,
  });
  assert.equal(usage.timestamp, "2026-07-23T12:34:56.000Z");
});

test("ignores cumulative totals without last-token usage", () => {
  const record = {
    payload: {
      info: { total_token_usage: { input_tokens: 1_000 } },
    },
  };
  assert.equal(parseCodexUsage(record, EMPTY), null);
});

test("tracks session, cwd, and model context from Codex records", () => {
  let context = updateCodexContext(
    { type: "session_meta", payload: { id: "session-secret", cwd: "/work/first" } },
    EMPTY,
  );
  assert.deepEqual(context, { project: "/work/first", model: null, session: "session-secret" });

  context = updateCodexContext(
    { type: "turn_context", payload: { cwd: "/work/second", model: "gpt-example" } },
    context,
  );
  assert.deepEqual(context, { project: "/work/second", model: "gpt-example", session: "session-secret" });

  const usage = parseCodexUsage(
    {
      type: "event_msg",
      timestamp: "2026-08-15T21:57:48.746Z",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } },
      },
    },
    context,
  );
  assert.ok(usage);
  assert.equal(usage.session, "session-secret");
  assert.equal(usage.model, "gpt-example");
});

test("parses OpenAI's own weekly rate-limit telemetry when present", () => {
  const limits = parseCodexRateLimits({
    payload: {
      rate_limits: {
        primary: { used_percent: 10.0, window_minutes: 10080, resets_at: 1787236649 },
        plan_type: "plus",
      },
    },
  });
  assert.ok(limits);
  assert.equal(limits.usedPercent, 10);
  assert.equal(limits.windowMinutes, 10080);
  assert.equal(limits.resetsAt?.toISOString(), new Date(1787236649 * 1000).toISOString());

  assert.equal(parseCodexRateLimits({ payload: {} }), null);
});
