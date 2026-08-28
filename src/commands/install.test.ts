import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cursorHooksInstalled, installCommand } from "./install.js";
import { tempHome } from "../test-home.js";

test("cursor install wrapper invokes llm cli cursor hook", () => {
  const home = tempHome("llm-budget-install-");
  try {
    assert.equal(cursorHooksInstalled(home), false);
    const result = installCommand(home);
    const wrapper = readFileSync(join(home, ".cursor", "hooks", "llm-budget"), "utf8");
    assert.match(wrapper, /llm\/cli\.js/);
    assert.match(wrapper, /cursor hook/);
    assert.doesNotMatch(wrapper, /cli\.js hook/);
    assert.match(wrapper, /Node\.js was not found/);
    assert.match(wrapper, /exit 2/);
    assert.doesNotMatch(wrapper, /continue\\":true/);
    assert.match(result, /Installed llm-budget Cursor Agent hooks/);
    assert.equal(cursorHooksInstalled(home), true);

    // SAFETY: installCommand writes hooks.json as an object whose hooks values are arrays.
    const hooks = JSON.parse(readFileSync(join(home, ".cursor", "hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ failClosed?: boolean }>>;
    };
    for (const entries of Object.values(hooks.hooks)) {
      assert.equal(entries[0]?.failClosed, true);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
