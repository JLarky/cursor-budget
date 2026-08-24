import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureConfig } from "../config.js";
import { hookWrapperPath, hooksJsonPath } from "../paths.js";

/** Events the guard actually handles (enforce + record). */
const HOOK_EVENTS = [
  "beforeSubmitPrompt",
  "afterAgentThought",
  "afterAgentResponse",
  "preToolUse",
  "beforeShellExecution",
  "beforeMCPExecution",
  "beforeReadFile",
  "subagentStart",
] as const;

/** Old events we no longer handle — strip leftover entries on install. */
const OBSOLETE_HOOK_EVENTS = ["preCompact"] as const;

function isCursorBudgetEntry(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "command" in entry &&
    String((entry as { command: string }).command).includes("llm-budget")
  );
}

export function installCommand(): string {
  ensureConfig();
  const home = homedir();
  const wrapper = hookWrapperPath(home);
  const hooksPath = hooksJsonPath(home);
  const cli = join(fileURLToPath(new URL("../cli.js", import.meta.url)));

  mkdirSync(dirname(wrapper), { recursive: true });
  writeFileSync(
    wrapper,
    `#!/bin/bash
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
  echo '{"continue":true,"permission":"allow"}'
  exit 0
fi
exec "$NODE" ${JSON.stringify(cli)} hook "$@"
`,
  );
  chmodSync(wrapper, 0o755);

  let hooks: { version: number; hooks: Record<string, unknown[]> } = {
    version: 1,
    hooks: {},
  };
  if (existsSync(hooksPath)) {
    hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
    hooks.hooks ??= {};
  }

  for (const event of OBSOLETE_HOOK_EVENTS) {
    const list = Array.isArray(hooks.hooks[event]) ? hooks.hooks[event] : [];
    const next = list.filter((entry) => !isCursorBudgetEntry(entry));
    if (next.length === 0) delete hooks.hooks[event];
    else hooks.hooks[event] = next;
  }

  for (const event of HOOK_EVENTS) {
    const list = Array.isArray(hooks.hooks[event]) ? hooks.hooks[event] : [];
    const already = list.some(isCursorBudgetEntry);
    if (!already) {
      list.push({
        command: "./hooks/llm-budget",
        failClosed: false,
      });
    }
    hooks.hooks[event] = list;
  }

  writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
  return `Installed llm-budget Cursor Agent hooks (failClosed: false)\n  ${hooksPath}\n  ${wrapper}\n`;
}
