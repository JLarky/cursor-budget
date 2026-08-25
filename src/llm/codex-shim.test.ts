import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { installCodexShim, uninstallCodexShim } from "./codex-shim.js";
import { tempHome } from "../test-home.js";

test("install writes an executable shim that consults codex-guard first", () => {
  const home = tempHome("llm-budget-shim-");
  const output = installCodexShim(home);
  assert.match(output, /PATH/);

  const shimPath = join(home, ".local/share/llm-budget", "bin", "codex");
  const mode = statSync(shimPath).mode & 0o777;
  assert.equal(mode, 0o755);

  const contents = readFileSync(shimPath, "utf8");
  assert.match(contents, /codex-guard/);
  // Strips its own dir from PATH before resolving the real binary.
  assert.match(contents, /SHIM_DIR/);
  assert.match(contents, /exec "\$REAL" "\$@"/);
});

test("shim rebuilds PATH exactly: filters only its own dir, keeps all empties", () => {
  const home = tempHome("llm-budget-shim-e2e-");
  installCodexShim(home);
  mkdirSync(join(home, ".config", "llm-budget"), { recursive: true });
  writeFileSync(
    join(home, ".config", "llm-budget", "config.jsonc"),
    '{ "enforcement": { "failClosed": false } }\n',
  );
  const sibling = join(home, "sibling-bin-tools");
  mkdirSync(sibling, { recursive: true });
  const globDir = join(home, "glob*dir");
  mkdirSync(globDir, { recursive: true });
  const fake = join(home, "fakebin");
  mkdirSync(fake, { recursive: true });
  // Echo the PATH this codex was exec'd with — proves what survived filtering.
  writeFileSync(join(fake, "codex"), `#!/bin/bash\nprintf '%s' "$PATH"\n`);
  chmodSync(join(fake, "codex"), 0o755);

  const shimPath = join(home, ".local/share/llm-budget", "bin", "codex");
  const nodeDir = join(process.execPath, "..");

  // Interior empty + glob dir + sibling survive; shim dir filtered.
  const interior = `${join(home, ".local/share/llm-budget", "bin")}:${fake}:${sibling}:${globDir}::${nodeDir}`;
  const r1 = spawnSync(shimPath, ["exec"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: interior },
  });
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r1.stdout, `${fake}:${sibling}:${globDir}::${nodeDir}`);

  // Leading empty survives.
  const leading = `:${join(home, ".local/share/llm-budget", "bin")}:${fake}:${nodeDir}`;
  const r2 = spawnSync(shimPath, ["exec"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: leading },
  });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(r2.stdout, `:${fake}:${nodeDir}`);

  // Trailing empty survives.
  const trailing = `${join(home, ".local/share/llm-budget", "bin")}:${fake}:${nodeDir}:`;
  const r3 = spawnSync(shimPath, ["exec"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: trailing },
  });
  assert.equal(r3.status, 0, r3.stderr);
  assert.equal(r3.stdout, `${fake}:${nodeDir}:`);
});

test("uninstall refuses to touch foreign files and keeps a disabled copy", () => {
  const home = tempHome("llm-budget-shim-");
  assert.match(uninstallCodexShim(home), /No llm-budget codex shim found/);

  const shimPath = join(home, ".local/share/llm-budget", "bin", "codex");
  mkdirSync(join(home, ".local/share/llm-budget", "bin"), { recursive: true });
  writeFileSync(shimPath, "#!/bin/bash\n# some other tool entirely\n");
  assert.match(uninstallCodexShim(home), /Refusing to remove/);

  installCodexShim(home);
  const result = uninstallCodexShim(home);
  assert.match(result, /Removed llm-budget codex shim/);
  assert.equal(existsSync(shimPath), false);
  assert.ok(existsSync(`${shimPath}.removed`));
});
