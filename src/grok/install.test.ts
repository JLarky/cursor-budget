import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tempHome } from "../test-home.js";
import { grokHookWrapperPath, grokHooksFilePath } from "../llm/paths.js";
import { grokDenyJson, grokHookInstalled, installGrokHook, uninstallGrokHook } from "./install.js";

test("install writes the owned hooks file and a matching wrapper", () => {
  const home = tempHome("llm-budget-grok-install-");
  const report = installGrokHook(home);
  assert.match(report, /Installed llm-budget Grok CLI hooks/);
  assert.equal(grokHookInstalled(home), true);

  const hooks = JSON.parse(readFileSync(grokHooksFilePath(home), "utf8"));
  assert.equal(hooks.hooks.PreToolUse.length, 1);
  assert.equal(hooks.hooks.PreToolUse[0].command, grokHookWrapperPath(home));
  assert.equal(hooks.hooks.PreToolUse[0].timeout, 10);
  assert.equal(hooks.hooks.UserPromptSubmit, undefined);
  assert.equal(hooks.hooks.Stop, undefined);
});

test("install is idempotent — a second run keeps exactly one owned entry", () => {
  const home = tempHome("llm-budget-grok-idempotent-");
  installGrokHook(home);
  installGrokHook(home);
  const hooks = JSON.parse(readFileSync(grokHooksFilePath(home), "utf8"));
  assert.equal(hooks.hooks.PreToolUse.length, 1);
  assert.equal(grokHookInstalled(home), true);
});

test("GROK_HOME overrides where the hooks file and auth live", () => {
  const home = tempHome("llm-budget-grok-home-real-");
  const grokHome = tempHome("llm-budget-grok-home-override-");
  const originalEnv = process.env.GROK_HOME;
  process.env.GROK_HOME = grokHome;
  try {
    installGrokHook(home);
    assert.equal(grokHookInstalled(home), true);
    const hooksPath = grokHooksFilePath(home);
    assert.equal(hooksPath, join(grokHome, "hooks", "llm-budget.json"));
    assert.equal(existsSync(join(home, ".grok")), false, "GROK_HOME must fully replace ~/.grok");
  } finally {
    if (originalEnv === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = originalEnv;
  }
});

test("uninstall deletes the owned hooks file and leaves the wrapper", () => {
  const home = tempHome("llm-budget-grok-uninstall-");
  installGrokHook(home);
  const uninstallReport = uninstallGrokHook(home);
  assert.match(uninstallReport, /Removed llm-budget Grok CLI hooks/);
  assert.equal(grokHookInstalled(home), false);

  const again = uninstallGrokHook(home);
  assert.match(again, /No llm-budget Grok CLI hooks found/);
});

test("the wrapper contains the deny JSON for a missing Node", () => {
  const home = tempHome("llm-budget-grok-wrapper-");
  installGrokHook(home);
  const wrapper = readFileSync(grokHookWrapperPath(home), "utf8");
  const expected = grokDenyJson(
    "llm-budget: Grok budget could not be checked. Run llm-budget grok status",
  );
  assert.ok(wrapper.includes(expected), "wrapper must embed the deny JSON literal");
  assert.match(wrapper, /grok hook/);
  assert.doesNotMatch(wrapper, /\bexec\b/);
  assert.match(wrapper, /\[ ! -s "\$out" \]/);
  assert.match(wrapper, /timeout 8 /);
});
