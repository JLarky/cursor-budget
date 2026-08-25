import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cursorHooksInstalled, installCommand } from "./install.js";

test("cursor install wrapper invokes llm cli cursor hook", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-install-"));
  try {
    assert.equal(cursorHooksInstalled(home), false);
    const result = installCommand(home);
    const wrapper = readFileSync(join(home, ".cursor", "hooks", "llm-budget"), "utf8");
    assert.match(wrapper, /llm\/cli\.js/);
    assert.match(wrapper, /cursor hook/);
    assert.doesNotMatch(wrapper, /cli\.js hook/);
    assert.match(result, /Installed llm-budget Cursor Agent hooks/);
    assert.equal(cursorHooksInstalled(home), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
