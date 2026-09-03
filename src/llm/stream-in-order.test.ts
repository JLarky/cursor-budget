import assert from "node:assert/strict";
import test from "node:test";
import { streamInOrder } from "./stream-in-order.js";

function delayed<T>(value: T, ms: number): () => Promise<T> {
  return () => new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

test("streamInOrder waits out the grace window before skipping the head", async () => {
  const output: string[] = [];
  const start = Date.now();
  const timings: number[] = [];
  await streamInOrder(
    [
      async () => {
        const value = await delayed("slow", 250)();
        return value;
      },
      async () => {
        const value = await delayed("fast-codex", 20)();
        return value;
      },
      async () => {
        const value = await delayed("fast-grok", 30)();
        return value;
      },
    ],
    200,
    (chunk) => {
      timings.push(Date.now() - start);
      output.push(chunk.trim());
    },
  );
  // The head (slow) has not settled after 200ms grace, so codex (already
  // ready) prints first. The head is re-checked next, and slow settles at
  // 250ms — inside its second grace window — so it prints before grok gets
  // a turn, even though grok has been ready since 30ms.
  assert.deepEqual(output, ["fast-codex", "slow", "fast-grok"]);
  assert.ok(timings[0]! >= 200, `expected first print after grace (>=200ms), got ${timings[0]}`);
});

test("streamInOrder prints in declared order when everything settles within the grace window", async () => {
  const output: string[] = [];
  await streamInOrder(
    [delayed("a", 5), delayed("b", 1), delayed("c", 3)],
    200,
    (chunk) => output.push(chunk.trim()),
  );
  assert.deepEqual(output, ["a", "b", "c"]);
});

test("streamInOrder turns a rejected task into an error line and keeps going", async () => {
  const output: string[] = [];
  await streamInOrder(
    [
      delayed("a", 1),
      () => Promise.reject(new Error("codex failed")),
      delayed("c", 1),
    ],
    200,
    (chunk) => output.push(chunk.trim()),
  );
  assert.deepEqual(output, ["a", "Error: codex failed", "c"]);
});
