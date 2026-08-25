import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

test("notify ignores missing notify-send without throwing", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const childProcess = require("node:child_process") as typeof import("node:child_process");
  const originalSpawn = childProcess.spawn;

  class FakeChild extends EventEmitter {
    unref(): this {
      return this;
    }
  }

  const child = new FakeChild();
  (childProcess as { spawn: typeof childProcess.spawn }).spawn = (() =>
    child as unknown as ReturnType<typeof childProcess.spawn>) as typeof childProcess.spawn;

  try {
    const { notify } = await import("./notify.js");
    assert.doesNotThrow(() => notify("llm-budget", "hello"));
    assert.doesNotThrow(() => child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })));
  } finally {
    childProcess.spawn = originalSpawn;
  }
});
