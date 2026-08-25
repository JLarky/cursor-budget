import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installCommand } from "./install.js";

test("cursor install wrapper invokes llm cli cursor hook", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-install-"));
  try {
    const result = installCommand(home);
    const wrapper = readFileSync(join(home, ".cursor", "hooks", "llm-budget"), "utf8");
    assert.match(wrapper, /llm\/cli\.js/);
    assert.match(wrapper, /cursor hook/);
    assert.doesNotMatch(wrapper, /cli\.js hook/);
    assert.match(result, /Installed llm-budget Cursor Agent hooks/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
