import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { budgetDir, hookWrapperPath, hooksJsonPath } from "../paths.js";

export function uninstallCommand(purgeData: boolean, home = homedir()): string {
  const hooksPath = hooksJsonPath(home);
  if (existsSync(hooksPath)) {
    const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      version: number;
      hooks: Record<string, unknown[]>;
    };
    for (const [event, list] of Object.entries(hooks.hooks ?? {})) {
      hooks.hooks[event] = (list ?? []).filter((entry) => {
        if (typeof entry !== "object" || entry === null || !("command" in entry)) return true;
        return !String((entry as { command: string }).command).includes("llm-budget");
      });
      if (hooks.hooks[event].length === 0) delete hooks.hooks[event];
    }
    writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
  }

  const wrapper = hookWrapperPath(home);
  if (existsSync(wrapper)) rmSync(wrapper);

  const lines = ["Removed llm-budget Cursor Agent hook entries and wrapper."];
  if (purgeData) {
    rmSync(budgetDir(home), { recursive: true, force: true });
    lines.push("Purged ~/.cursor/llm-budget/");
  } else {
    lines.push("Kept usage data in ~/.cursor/llm-budget/");
  }
  return `${lines.join("\n")}\n`;
}
