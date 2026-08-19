import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { limitCommand } from "./limit.js";

test("limit set, list, and clear", () => {
  const home = mkdtempSync(join(tmpdir(), "cursor-budget-limit-"));
  try {
    const listed = limitCommand(["list"], home);
    assert.match(listed, /usd off/);
    const hourly = limitCommand(["hour", "usd", "1"], home);
    assert.match(hourly, /\$1\.00/);
    const daily = limitCommand(["day", "tokens", "200k"], home);
    assert.match(daily, /200k/);
    const cleared = limitCommand(["hour", "usd", "off"], home);
    assert.match(cleared, /Hour \(rolling 60m\)  usd off/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
