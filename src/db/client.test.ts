import assert from "node:assert/strict";
import test from "node:test";
import { makeDedupeKey } from "./client.js";

test("same content without generation id differs across minutes", () => {
  const a = makeDedupeKey(undefined, "beforeSubmitPrompt", "continue", {
    conversationId: "conv-1",
    timestamp: "2026-08-19T12:00:10.000Z",
  });
  const b = makeDedupeKey(undefined, "beforeSubmitPrompt", "continue", {
    conversationId: "conv-1",
    timestamp: "2026-08-19T12:01:10.000Z",
  });
  assert.notEqual(a, b);
});

test("same content within the same minute without generation id still dedupes", () => {
  const a = makeDedupeKey("-", "beforeSubmitPrompt", "continue", {
    conversationId: "conv-1",
    timestamp: "2026-08-19T12:00:10.000Z",
  });
  const b = makeDedupeKey(undefined, "beforeSubmitPrompt", "continue", {
    conversationId: "conv-1",
    timestamp: "2026-08-19T12:00:50.000Z",
  });
  assert.equal(a, b);
});

test("generation id scopes dedupe without needing a time bucket", () => {
  const a = makeDedupeKey("gen-1", "afterAgentThought", "hello");
  const b = makeDedupeKey("gen-1", "afterAgentThought", "hello", {
    conversationId: "conv-1",
    timestamp: "2026-08-19T12:00:10.000Z",
  });
  assert.equal(a, b);
});
