import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

type NotifyChildProcess = {
  spawn: () => EventEmitter & { unref(): EventEmitter };
};

test("notify ignores missing notify-send without throwing", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  // SAFETY: createRequire returns the mutable CommonJS node:child_process module.
  const childProcess = require("node:child_process") as NotifyChildProcess;
  const originalSpawn = childProcess.spawn;

  class FakeChild extends EventEmitter {
    unref(): this {
      return this;
    }
  }

  const child = new FakeChild();
  // SAFETY: test stub only needs spawn() to return an EventEmitter with unref().
  childProcess.spawn = (() => child) as typeof childProcess.spawn;

  try {
    const { notify } = await import("./notify.js");
    assert.doesNotThrow(() => notify("llm-budget", "hello"));
    assert.doesNotThrow(() => child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })));
  } finally {
    childProcess.spawn = originalSpawn;
  }
});
