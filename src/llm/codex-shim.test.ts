import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

test("shim resolves the real binary even with hostile PATH entries", () => {
  const home = mkdtempSync(join(tmpdir(), "llm-budget-shim-e2e-"));
  installCodexShim(home);
  // Sibling dir with the shim dir as a prefix, a glob-looking entry, and an
  // empty component (POSIX current-dir) must all survive; only the exact
  // shim dir is filtered out.
  const sibling = join(home, "sibling-bin-tools");
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "codex"), "#!/bin/bash\necho WRONG_CODEX\n");
  chmodSync(join(sibling, "codex"), 0o755);

  const fake = join(home, "fakebin");
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, "codex"), "#!/bin/bash\necho RIGHT_CODEX\n");
  chmodSync(join(fake, "codex"), 0o755);

  const globDir = join(home, "glob*dir");
  mkdirSync(globDir, { recursive: true });

  const shimPath = join(home, ".llm-budget", "bin", "codex");
  const result = spawnSync(shimPath, ["exec", "--flag"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      // Shim dir first (to be filtered), then the real codex, then hostile
      // entries (must be preserved but never win), then node's dir so the
      // wrapper can exec both.
      PATH: `${join(home, ".llm-budget", "bin")}:${fake}:${sibling}:${globDir}::${join(
        process.execPath,
        "..",
      )}:/usr/bin:/bin`,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RIGHT_CODEX/);
  assert.doesNotMatch(result.stdout, /WRONG_CODEX/);
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
