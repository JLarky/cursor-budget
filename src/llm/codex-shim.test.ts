import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installCodexShim, uninstallCodexShim } from "./codex-shim.js";

test("install writes an executable shim that consults codex-guard first", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-shim-"));
  const output = installCodexShim(home);
  assert.match(output, /PATH/);

  const shimPath = join(home, ".llm-budget", "bin", "codex");
  const mode = statSync(shimPath).mode & 0o777;
  assert.equal(mode, 0o755);

  const contents = readFileSync(shimPath, "utf8");
  assert.match(contents, /codex-guard/);
  // Strips its own dir from PATH before resolving the real binary.
  assert.match(contents, /SHIM_DIR/);
  assert.match(contents, /exec "\$REAL" "\$@"/);
});

test("uninstall refuses to touch foreign files and keeps a disabled copy", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-shim-"));
  assert.match(uninstallCodexShim(home), /No llm-budget codex shim found/);

  const shimPath = join(home, ".llm-budget", "bin", "codex");
  mkdirSync(join(home, ".llm-budget", "bin"), { recursive: true });
  writeFileSync(shimPath, "#!/bin/bash\n# some other tool entirely\n");
  assert.match(uninstallCodexShim(home), /Refusing to remove/);

  installCodexShim(home);
  const result = uninstallCodexShim(home);
  assert.match(result, /Removed llm-budget codex shim/);
  assert.equal(existsSync(shimPath), false);
  assert.ok(existsSync(`${shimPath}.removed`));
});
