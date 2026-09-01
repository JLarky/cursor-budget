import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureConfig } from "../config.js";
import { grokHookWrapperPath, grokHooksFilePath } from "../llm/paths.js";
import { asJsonArray, asJsonObject, parseJsonText } from "../json-value.js";

/**
 * Declared in `~/.grok/hooks/llm-budget.json` and used as the wrapper's
 * `mktemp` timeout budget, so the two cannot drift. A cold Node start plus an
 * OIDC refresh plus an HTTPS call can approach Grok's own default.
 */
export const GROK_HOOK_TIMEOUT_S = 10;
/** Seconds the wrapper gives Node, shorter than the declared hook timeout so a hung process still leaves a deny. */
export const GROK_HOOK_INNER_TIMEOUT_S = GROK_HOOK_TIMEOUT_S - 2;

/**
 * The only place in the codebase that spells the deny protocol. Grok honors a
 * stdout deny regardless of exit code, so these bytes are the enforcement.
 * Shared by the Node reply path and interpolated into the wrapper's no-Node
 * fallback, so there is exactly one deny envelope shape.
 */
export function grokDenyJson(reason: string): string {
  return JSON.stringify({ decision: "deny", reason });
}

const WRAPPER_MISSING_NODE_REASON =
  "llm-budget: Grok budget could not be checked. Run llm-budget grok status";

/**
 * Deny-envelope wrapper: supervise Node rather than `exec` it, so a crash or
 * timeout still leaves deny JSON. Allow is only exit 0 with empty stdout.
 * Any other bytes, including allow JSON, become the wrapper deny.
 */
function wrapperScript(cli: string): string {
  return `#!/bin/bash
DENY='${grokDenyJson(WRAPPER_MISSING_NODE_REASON)}'
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
  printf '%s\\n' "$DENY"
  exit 2
fi
out="$(mktemp)"
code=0
if command -v timeout >/dev/null 2>&1; then
  timeout ${GROK_HOOK_INNER_TIMEOUT_S} "$NODE" ${JSON.stringify(cli)} grok hook >"$out" 2>/dev/null || code=$?
else
  "$NODE" ${JSON.stringify(cli)} grok hook >"$out" 2>/dev/null || code=$?
fi
if grep -q '"decision":"deny"' "$out" 2>/dev/null; then
  cat "$out"
  rm -f "$out"
  exit 2
fi
if [ "$code" -eq 0 ] && [ ! -s "$out" ]; then
  rm -f "$out"
  exit 0
fi
printf '%s\\n' "$DENY"
rm -f "$out"
exit 2
`;
}

/**
 * Write `~/.grok/hooks/llm-budget.json` and the wrapper.
 *
 * llm-budget owns that filename outright in a directory Grok globs, so
 * install is a write and uninstall is a delete — no merge, no malformed-file
 * preservation dance. Idempotent because writing the same bytes twice is
 * idempotent. Registers `PreToolUse` only, no matcher (an omitted matcher
 * matches every tool), `timeout: GROK_HOOK_TIMEOUT_S`.
 */
export function installGrokHook(home = homedir()): string {
  ensureConfig(home);
  const wrapper = grokHookWrapperPath(home);
  const hooksFile = grokHooksFilePath(home);
  const cli = fileURLToPath(new URL("../llm/cli.js", import.meta.url));

  mkdirSync(dirname(wrapper), { recursive: true });
  writeFileSync(wrapper, wrapperScript(cli));
  chmodSync(wrapper, 0o755);

  // Grok globs ~/.grok/hooks/*.json and only runs nested `{ type: "command", command }`.
  // A Cursor-shaped `{ command, timeout }` on the matcher group is ignored, so the tool proceeds.
  const hooks = {
    hooks: {
      PreToolUse: [
        {
          hooks: [{ type: "command", command: wrapper, timeout: GROK_HOOK_TIMEOUT_S }],
        },
      ],
    },
  };
  mkdirSync(dirname(hooksFile), { recursive: true });
  writeFileSync(hooksFile, `${JSON.stringify(hooks, null, 2)}\n`);

  return ["Installed llm-budget Grok CLI hooks", `  ${hooksFile}`, `  ${wrapper}`].join("\n") + "\n";
}

/** Deletes the owned hooks file. Leaves the wrapper in place, matching the other scopes. */
export function uninstallGrokHook(home = homedir()): string {
  const hooksFile = grokHooksFilePath(home);
  if (!existsSync(hooksFile)) {
    return "No llm-budget Grok CLI hooks found.\n";
  }
  rmSync(hooksFile, { force: true });
  return `Removed llm-budget Grok CLI hooks from ${hooksFile}\n`;
}

/** True when our file exists, parses, and its PreToolUse command is our wrapper. */
export function grokHookInstalled(home = homedir()): boolean {
  const wrapper = grokHookWrapperPath(home);
  try {
    const parsed = asJsonObject(parseJsonText(readFileSync(grokHooksFilePath(home), "utf8")));
    const hooks = asJsonObject(parsed?.hooks);
    const entries = asJsonArray(hooks?.PreToolUse) ?? [];
    return entries.some((entry) => {
      const group = asJsonObject(entry);
      if (group === null) return false;
      if (group.command === wrapper) return true;
      const handlers = asJsonArray(group.hooks) ?? [];
      return handlers.some((handler) => asJsonObject(handler)?.command === wrapper);
    });
  } catch {
    return false;
  }
}
