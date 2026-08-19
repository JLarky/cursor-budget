import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureConfig } from "../config.js";
import { hookWrapperPath, hooksJsonPath } from "../paths.js";

const HOOK_EVENTS = [
  "beforeSubmitPrompt",
  "afterAgentThought",
  "afterAgentResponse",
  "preToolUse",
  "beforeShellExecution",
  "preCompact",
] as const;

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

  for (const event of HOOK_EVENTS) {
    const list = Array.isArray(hooks.hooks[event]) ? hooks.hooks[event] : [];
    const already = list.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "command" in entry &&
        String((entry as { command: string }).command).includes("cursor-budget"),
    );
    if (!already) {
      list.push({
        command: "./hooks/cursor-budget",
        failClosed: false,
      });
    }
    hooks.hooks[event] = list;
  }

  writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
  return `Installed cursor-budget hooks (failClosed: false)\n  ${hooksPath}\n  ${wrapper}\n`;
}
