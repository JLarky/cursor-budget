import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLlmConfig } from "./config.js";
import { codexShimDir, codexShimPath } from "./paths.js";

/**
 * Codex has no deny hooks, so enforcement is a PATH shim: `~/.local/share/llm-budget/bin/codex`
 * checks the budget first and only then execs the real binary. Users put the
 * shim dir ahead on their PATH (install prints the exact export line).
 *
 * Honest gap (also in README): this gates *starting* Codex. A session that is
 * already running keeps going until the watchdog kills it — see watchdog.ts.
 */
export function installCodexShim(home = homedir()): string {
  ensureLlmConfig(home);
  const shimPath = codexShimPath(home);
  const cli = join(fileURLToPath(new URL("./cli.js", import.meta.url)));
  const shimDirValue = codexShimDir(home);

  mkdirSync(shimDirValue, { recursive: true });

  // Resolve the real binary at runtime with the shim's own dir removed from
  // PATH, so the shim never recurses into itself.
  writeFileSync(
    shimPath,
    `#!/bin/bash
# Installed by llm-budget codex install. Consults the budget guard, then
# execs the real codex binary.
NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then
  for candidate in "$HOME/.vite-plus/bin/node" /usr/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      NODE="$candidate"
      break
    fi
  done
fi
if [ -z "$NODE" ]; then
  echo "llm-budget: node not found; cannot check budget" >&2
  exit 2
fi
SHIM_DIR=${JSON.stringify(shimDirValue)}
SAVE_PATH="$PATH"
# Remove SHIM_DIR as an exact PATH component. Iterate with \${var%%:*} /
# \${var#*:} so glob-like entries are never expanded, and track whether a
# component has been emitted (\$SEEN) so leading/interior/trailing empty
# components (POSIX "current directory") all survive intact.
NEW_PATH=""
SEEN=0
REST="$SAVE_PATH"
while [ -n "$REST" ]; do
  D="\${REST%%:*}"
  case "$REST" in
    *:*) REST="\${REST#*:}" ;;
    *) REST="" ;;
  esac
  if [ "$D" != "$SHIM_DIR" ]; then
    if [ "$SEEN" -eq 0 ]; then
      NEW_PATH="$D"
      SEEN=1
    else
      NEW_PATH="\${NEW_PATH}:\${D}"
    fi
  fi
done
# A trailing ":" (empty last component) never reaches the loop above.
case "$SAVE_PATH" in
  *:) NEW_PATH="\${NEW_PATH}:" ;;
esac
PATH="$NEW_PATH"
REAL="$(command -v codex 2>/dev/null)"
if [ -z "$REAL" ]; then
  echo "llm-budget: real codex binary not found on PATH (is the shim dir shadowing everything?)" >&2
  exit 1
fi
# Budget check runs with the real codex still resolvable but shadowed only by
# us; we keep NEW_PATH so a nested codex call from inside the session cannot
# loop back through this shim.
if ! "$NODE" ${JSON.stringify(cli)} codex-guard; then
  # Guard already printed its block message (with escape hatches) on stderr.
  exit 2
fi
exec "$REAL" "$@"
`,
  );
  chmodSync(shimPath, 0o755);

  return [
    "Installed llm-budget Codex shim",
    `  ${shimPath}`,
    "",
    "Put the shim ahead of the real codex on your PATH:",
    `  export PATH=${JSON.stringify(`${shimDirValue}:$PATH`)}`,
    "(add that line to your shell profile)",
    "",
    `Pair it with the watchdog so running sessions also stop: llm-budget watchdog`,
  ].join("\n");
}

export function uninstallCodexShim(home = homedir()): string {
  const shimPath = codexShimPath(home);
  if (!existsSync(shimPath)) return "No llm-budget codex shim found.\n";
  const contents = readFileSync(shimPath, "utf8");
  if (!contents.includes("llm-budget")) {
    return `Refusing to remove ${shimPath}: not an llm-budget shim.\n`;
  }
  // Keep a disabled copy so undoing an accidental uninstall is trivial.
  renameSync(shimPath, `${shimPath}.removed`);
  return [
    "Removed llm-budget codex shim",
    `  (disabled copy kept at ${shimPath}.removed)`,
    "",
    "Remove the PATH export from your shell profile if you added one.",
  ].join("\n");
}

export function codexShimInstalled(home = homedir()): boolean {
  const shimPath = codexShimPath(home);
  if (!existsSync(shimPath)) return false;
  try {
    return readFileSync(shimPath, "utf8").includes("codex-guard");
  } catch {
    return false;
  }
}
