#!/usr/bin/env node
import { configCommand } from "./commands/config.js";
import { exceptCommand } from "./commands/except.js";
import { historyCommand } from "./commands/history.js";
import { installCommand } from "./commands/install.js";
import { limitCommand } from "./commands/limit.js";
import { overrideCommand } from "./commands/override.js";
import { statusCommand } from "./commands/status.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { handleHook, readStdinJson } from "./hook.js";

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "hook": {
      const event = await readStdinJson();
      const response = await handleHook(event);
      process.stdout.write(JSON.stringify(response));
      process.exitCode = 0;
      return;
    }
    case "status":
      process.stdout.write(`${await statusCommand()}\n`);
      return;
    case "config":
      process.stdout.write(configCommand());
      return;
    case "override":
      process.stdout.write(overrideCommand(rest[0]));
      return;
    case "history":
      process.stdout.write(historyCommand());
      return;
    case "except":
    case "exclude":
      process.stdout.write(exceptCommand(rest));
      return;
    case "limit":
    case "budget":
      process.stdout.write(limitCommand(rest));
      return;
    case "install":
      process.stdout.write(installCommand());
      return;
    case "uninstall":
      process.stdout.write(uninstallCommand(rest.includes("--purge-data")));
      return;
    case "-h":
    case "--help":
    case "help":
    case undefined:
      process.stdout.write(`cursor-budget — estimated Cursor usage guard

Usage:
  cursor-budget hook
  cursor-budget status
  cursor-budget config
  cursor-budget override 15m|30m|1h|off
  cursor-budget except add <session-id>
  cursor-budget except remove <session-id>
  cursor-budget except list
  cursor-budget limit list
  cursor-budget limit hour usd 1
  cursor-budget limit day usd 4
  cursor-budget limit hour tokens 200000
  cursor-budget limit hour usd off
  cursor-budget history
  cursor-budget install
  cursor-budget uninstall [--purge-data]

Accounting is estimated from locally observable Cursor activity.
It is not Cursor billed spend.
`);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv[2] === "hook") {
    process.stdout.write(JSON.stringify({ continue: true, permission: "allow" }));
    process.exitCode = 0;
    return;
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
