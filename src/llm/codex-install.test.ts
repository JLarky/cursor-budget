import assert from "node:assert/strict";
import { dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { codexHookStatePath, codexHooksPath } from "./paths.js";
import { installCodexHooks, uninstallCodexHooks } from "./codex-install.js";
import { tempHome } from "../test-home.js";

function fixture() {
  const home = tempHome("llm-budget-codex-state-");
  mkdirSync(join(home, ".codex"), { recursive: true });
  return home;
}

function writeState(home: string, key: string, hash: string) {
  mkdirSync(dirname(codexHookStatePath(home)), { recursive: true });
  writeFileSync(codexHookStatePath(home), JSON.stringify({ state: [{ key, trusted_hash: hash }] }));
  writeFileSync(join(home, ".codex", "config.toml"), `[hooks.state."${key}"]\nenabled = true\ntrusted_hash = "${hash}"\n`);
}

test("uninstall prunes shift-in orphan using the recorded hash", () => {
  const home = fixture();
  writeState(home, "/hooks.json:user_prompt_submit:0:0", "sha256:ours");
  writeFileSync(codexHooksPath(home), JSON.stringify({ hooks: { UserPromptSubmit: [] } }));
  uninstallCodexHooks(home);
  assert.doesNotMatch(readFileSync(join(home, ".codex", "config.toml"), "utf8"), /trusted_hash/);
});

test("shift-out foreign trusted hash is protected", () => {
  const home = fixture();
  const key = "/hooks.json:user_prompt_submit:0:0";
  writeState(home, key, "sha256:ours");
  writeFileSync(join(home, ".codex", "config.toml"), `[hooks.state."${key}"]\nenabled = true\ntrusted_hash = "sha256:foreign"\n`);
  uninstallCodexHooks(home);
  assert.match(readFileSync(join(home, ".codex", "config.toml"), "utf8"), /sha256:foreign/);
});

test("hash mismatch never deletes a user state record", () => {
  const home = fixture();
  const key = "/hooks.json:pre_tool_use:1:0";
  writeState(home, key, "sha256:recorded");
  writeFileSync(join(home, ".codex", "config.toml"), `[hooks.state."${key}"]\ntrusted_hash = "sha256:changed"\n`);
  uninstallCodexHooks(home);
  assert.match(readFileSync(join(home, ".codex", "config.toml"), "utf8"), /sha256:changed/);
});

test("uninstall works without hooks.json or Codex", () => {
  const home = fixture();
  const key = "/hooks.json:user_prompt_submit:0:0";
  writeState(home, key, "sha256:ours");
  uninstallCodexHooks(home);
  assert.doesNotMatch(readFileSync(join(home, ".codex", "config.toml"), "utf8"), /trusted_hash/);
  assert.match(readFileSync(codexHookStatePath(home), "utf8"), /"state": \[\]/);
});

test("malformed hooks.json survives install and uninstall byte-for-byte", () => {
  const home = fixture();
  const original = '{"hooks":{"UserPromptSubmit":[{"hooks":[{"command":"/foreign"}]}]';
  writeFileSync(codexHooksPath(home), original);
  writeState(home, "/hooks.json:user_prompt_submit:0:0", "sha256:ours");
  assert.match(installCodexHooks(home), /malformed/);
  assert.equal(readFileSync(codexHooksPath(home), "utf8"), original);
  uninstallCodexHooks(home);
  assert.equal(readFileSync(codexHooksPath(home), "utf8"), original);
});

test("install prunes a previously-owned matching orphan state", () => {
  const home = fixture();
  const key = "/hooks.json:user_prompt_submit:0:0";
  writeState(home, key, "sha256:ours");
  writeFileSync(codexHooksPath(home), JSON.stringify({ hooks: {} }));
  installCodexHooks(home);
  assert.doesNotMatch(readFileSync(join(home, ".codex", "config.toml"), "utf8"), /sha256:ours/);
});
