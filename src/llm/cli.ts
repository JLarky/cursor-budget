#!/usr/bin/env node
import { homedir } from "node:os";
import { formatBudgetBlockMessage, formatPercent } from "./budget/evaluator.js";
import { parseDuration } from "./budget/windows.js";
import {
  ClaudeHookInputError,
  handleClaudeHook,
  readClaudeHookEvent,
  type ClaudeHookEvent,
} from "./claude-hook.js";
import { installClaudeHooks, uninstallClaudeHooks, claudeHooksInstalled } from "./claude-install.js";
import {
  ensureLlmConfig,
  formatSharedConfigFile,
  loadLlmConfigForRead,
  writeLlmConfig,
} from "./config.js";
import { installCodexShim, uninstallCodexShim, codexShimInstalled } from "./codex-shim.js";
import { runWatchdog } from "./codex-watchdog.js";
import { getState, openLlmDb, setState } from "./db.js";
import { runGuard } from "./guard.js";
import {
  fetchDirectUsage,
  providerUsage,
  type UsageSnapshot,
} from "./usage/index.js";
// Cursor Agent scope — dashboard API; config lives in ~/.config/llm-budget with the other agents.
import { exceptCommand as cursorExceptCommand } from "../commands/except.js";
import { historyCommand as cursorHistoryCommand } from "../commands/history.js";
import { installCommand as cursorInstallCommand, cursorHooksInstalled } from "../commands/install.js";
import { overrideCommand as cursorOverrideCommand } from "../commands/override.js";
import { statusCommand as cursorStatusCommand } from "../commands/status.js";
import { uninstallCommand as cursorUninstallCommand } from "../commands/uninstall.js";
import { configCommand as cursorConfigCommand } from "../commands/config.js";
import { spendingCommand as cursorSpendingCommand } from "../commands/spending.js";
import { handleHook, readStdinJson } from "../hook.js";

async function main(): Promise<void> {
  // Piping into `head` and friends closes stdout early; exit quietly on EPIPE
  // instead of dumping an unhandled-error stack after the user got their data.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "cursor":
      await cursorScope(rest);
      return;
    case "claude": {
      const sub = rest[0];
      if (sub === "install") {
        process.stdout.write(`${installClaudeHooks()}\n`);
        return;
      }
      if (sub === "uninstall") {
        process.stdout.write(uninstallClaudeHooks());
        return;
      }
      if (sub === "hook") {
        // Internal: registered by `claude install`.
        const event = await readClaudeHookEvent();
        await respondToClaudeHook(event);
        return;
      }
      if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
        process.stdout.write(CLAUDE_SCOPE_HELP);
        return;
      }
      throw new Error(
        "Unknown command: llm-budget claude " + sub +
          "\nRun \`llm-budget claude help\`.",
      );
    }
    case "codex": {
      const sub = rest[0];
      if (sub === "install") {
        process.stdout.write(`${installCodexShim()}\n`);
        return;
      }
      if (sub === "uninstall") {
        process.stdout.write(uninstallCodexShim());
        return;
      }
      if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
        process.stdout.write(CODEX_SCOPE_HELP);
        return;
      }
      throw new Error(
        "Unknown command: llm-budget codex " + sub +
          "\nRun \`llm-budget codex help\`.",
      );
    }
    case "watchdog": {
      const once = rest.includes("--once");
      const intervalFlag = rest.indexOf("--interval");
      const intervalMs =
        intervalFlag >= 0 ? (parseDuration(rest[intervalFlag + 1] ?? "") ?? undefined) : undefined;
      await runWatchdog({ once, intervalMs });
      return;
    }
    case "codex-guard": {
      // Strict config on purpose: an unreadable config must fail closed here,
      // so use ensureLlmConfig and let the top-level handler exit non-zero.
      const config = ensureLlmConfig();
      const decision = await runGuard("codex", config);
      if (!decision.allow) {
        process.stderr.write(
          `${formatBudgetBlockMessage(decision.evaluation, "codex", decision.sessionId)}\n`,
        );
        process.exit(2);
      }
      return;
    }
    case "install": {
      process.stdout.write(installAll());
      return;
    }
    case "status":
    case "usage":
      process.stdout.write(await statusCommand());
      return;
    case "override":
      process.stdout.write(overrideCommand(rest[0]));
      return;
    case "except":
    case "exclude":
      process.stdout.write(exceptCommand(rest));
      return;
    case "config": {
      process.stdout.write(formatSharedConfigFile());
      return;
    }
    case undefined:
      // No arguments: show the live budget view up front; the help wall is
      // one keystroke away.
      process.stdout.write(await statusCommand());
      process.stdout.write(
        "\nRun \`llm-budget help\` for all commands and scopes.\n",
      );
      return;
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(HELP);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

/** `llm-budget cursor ...` — Cursor Agent scope. */
async function cursorScope(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "hook": {
      const event = await readStdinJson();
      const response = await handleHook(event);
      process.stdout.write(JSON.stringify(response));
      process.exitCode = 0;
      return;
    }
    case "status":
      process.stdout.write(`${await cursorStatusCommand()}\n`);
      return;
    case "spending":
    case "usage-api":
      process.stdout.write(await cursorSpendingCommand());
      return;
    case "config":
      process.stdout.write(cursorConfigCommand());
      return;
    case "override":
      process.stdout.write(cursorOverrideCommand(rest[0]));
      return;
    case "history":
      process.stdout.write(cursorHistoryCommand());
      return;
    case "except":
    case "exclude":
      process.stdout.write(cursorExceptCommand(rest));
      return;
    case "install":
      process.stdout.write(cursorInstallCommand());
      return;
    case "uninstall":
      process.stdout.write(cursorUninstallCommand(rest.includes("--purge-data")));
      return;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(CURSOR_HELP);
      return;
    default:
      throw new Error(`Unknown cursor command: ${sub}`);
  }
}

async function respondToClaudeHook(event: ClaudeHookEvent): Promise<void> {
  let response;
  try {
    response = await handleClaudeHook(event);
  } catch (error) {
    blockClaudeHook(
      "UserPromptSubmit",
      `llm-budget failed while checking budget:\n  ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (response.block && response.message) {
    blockClaudeHook(response.eventName, response.message);
    return;
  }
  // Allow: silent success.
}

/**
 * Block path for Claude Code hooks: the human-readable message goes to stderr
 * (fed back by every hook type) and exit code 2 is the portable blocking
 * error. We deliberately do NOT also write stdout JSON: mixing protocols is
 * ambiguous across client versions — exit 2 + stderr is honored everywhere.
 */
function blockClaudeHook(_eventName: string, message: string): void {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const CURSOR_HELP = `llm-budget cursor — Cursor Agent usage guard

Usage:
  llm-budget cursor status
  llm-budget cursor spending
  llm-budget cursor config
  llm-budget cursor override <duration>
  llm-budget cursor override off
  llm-budget cursor except add <session-id>
  llm-budget cursor except remove <session-id>
  llm-budget cursor except list
  llm-budget cursor history
  llm-budget cursor install
  llm-budget cursor uninstall [--purge-data]
  llm-budget cursor hook                # Used by the installed hooks

Primary gate uses Cursor dashboard period usage (Cursor Models / Other Models).
Backstop is a local rolling-hour event count.
`;

const CLAUDE_SCOPE_HELP = `llm-budget claude \u2014 Claude Code guard

Commands:
  llm-budget claude install     Register UserPromptSubmit + PreToolUse hooks
                                in ~/.claude/settings.json
  llm-budget claude uninstall   Remove those hooks
  llm-budget claude help        This text
`;

const CODEX_SCOPE_HELP = `llm-budget codex \u2014 Codex guard

Commands:
  llm-budget codex install      Install the PATH shim that wraps the codex binary
  llm-budget codex uninstall    Remove the PATH shim
  llm-budget codex help         This text

Pair with the sidecar enforcer:
  llm-budget watchdog [--interval <duration>] [--once]
`;

const HELP = `llm-budget \u2014 percent-based guards for Claude Code, Codex, and Cursor Agent

Usage:
  llm-budget                    Live status view for all three agents
  llm-budget status | usage     Same as the bare invocation
  llm-budget install            Register Claude, Codex, and Cursor guards
  llm-budget help               This text

Scopes \u2014 every agent supports: install | uninstall | help
  llm-budget claude help        Claude Code \u2014 native hooks in ~/.claude/settings.json
  llm-budget codex help         Codex CLI \u2014 PATH shim + sidecar watchdog
  llm-budget cursor help        Cursor Agent \u2014 dashboard API + ~/.cursor/hooks.json

Claude Code, Codex, and Cursor Agent share ~/.config/llm-budget/config.jsonc.
Override and exceptions stay per-scope so unblocking one agent does not
unblock another.

  llm-budget override <duration>         Bypass Claude Code + Codex gates
  llm-budget cursor override <duration>  Bypass Cursor Agent gates
  llm-budget except add <session-id>
  llm-budget cursor except add <session-id>
  llm-budget config
  llm-budget cursor config

How limits work: Claude Code and Codex read percentages from Anthropic
and OpenAI usage APIs (local login files). Cursor Agent reads the
Cursor dashboard API. Each gate blocks when usage reaches its
configured percent. If usage is unknown the guards block by default
(fail closed).
`;

async function statusCommand(home = homedir()): Promise<string> {
  const { config, warning } = loadLlmConfigForRead(home);
  const db = openLlmDb(home);
  const lines: string[] = ["llm-budget"];
  if (warning) lines.push(warning, "");

  let snapshot: UsageSnapshot | null = null;
  let fetchError: string | null = null;
  try {
    snapshot = await fetchDirectUsage({ home });
  } catch (error) {
    fetchError = error instanceof Error ? error.message : String(error);
  }

  for (const agent of ["claude", "codex"] as const) {
    const enabled = agent === "claude" ? config.claudeCode.enabled : config.codex.enabled;
    lines.push("");
    lines.push(agent === "claude" ? "Claude Code:" : "Codex:");
    if (agent === "claude") {
      lines.push(`  Hooks: ${formatInstallState(claudeHooksInstalled(home), "llm-budget claude install")}`);
    } else {
      lines.push(`  Shim: ${formatInstallState(codexShimInstalled(home), "llm-budget codex install")}`);
    }
    if (!enabled) {
      lines.push("  disabled in config");
      continue;
    }

    const provider = snapshot ? providerUsage(snapshot, agent) : null;
    if (!provider && !fetchError) {
      lines.push(`  Usage unknown — no ${agent} entry`);
    } else if (!provider && fetchError) {
      lines.push(`  Usage unknown — ${fetchError}`);
    } else if (provider) {
      if (provider.status !== "available") {
        lines.push(
          `  Usage ${provider.status}` +
            (provider.error ? ` — ${provider.error}` : ""),
        );
      }
      if (provider.windows.length === 0) {
        lines.push("  No usage windows reported yet");
      }
      for (const w of provider.windows) {
        const weekly = w.id === "weekly";
        const blockAt =
          agent === "claude"
            ? weekly
              ? config.claudeCode.weeklyBlockAtPercent
              : config.claudeCode.rolling5hBlockAtPercent
            : (config.codex.openAiWeeklyBlockAtPercent ?? config.codex.weeklyBlockAtPercent);
        const pct =
          typeof w.usedPct === "number" && Number.isFinite(w.usedPct)
            ? formatPercent(w.usedPct)
            : "unknown";
        const reset = w.resetsAt ? ` — resets ${w.resetsAt}` : "";
        lines.push(`  ${w.label}: ${pct} of ${formatPercent(blockAt)} block threshold${reset}`);
      }
    }

    // Escape hatches for this store (Claude Code and Codex share it).
    // Cursor Agent's override/exceptions render in its own block below.
    const overrideRaw = getState(db, "override_until");
    lines.push(`  Override: ${overrideRaw ? `until ${overrideRaw}` : "none"}`);
    lines.push(
      `  Exceptions: ${config.excludeSessionIds.length > 0 ? config.excludeSessionIds.join(", ") : "none"}`,
    );
    lines.push(
      `  On unknown usage: ${config.enforcement.failClosed ? "block (failClosed)" : "allow (failClosed off)"}`,
    );
  }

  // Cursor Agent is a peer of Claude Code and Codex in this view.
  // Dashboard auth may be unavailable offline — render whatever it reports.
  lines.push("");
  lines.push("Cursor Agent:");
  lines.push(`  Hooks: ${formatInstallState(cursorHooksInstalled(home), "llm-budget cursor install")}`);
  try {
    const raw = await cursorStatusCommand(home);
    const allLines = raw.split("\n");
    const titleIdx = allLines.findIndex((l) => l.trim() === "llm-budget");
    const body = (titleIdx >= 0 ? allLines.slice(titleIdx + 1) : allLines)
      .map((l) => {
        // Collapse multi-line API/auth failure detail into one peer-style line
        // so an offline Cursor does not visually dominate the output.
        const m = l.match(/^\s*Period usage: unavailable \(([^)]*)\)\s*$/);
        if (!m) return l;
        return "Dashboard quota: unavailable — sign in with cursor-agent";
      })
      .filter((l) => l.trim() !== "");
    if (body.length === 0) {
      lines.push("  no status available");
    } else {
      for (const l of body) lines.push(`  ${l}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message.split(":")[0] : String(error);
    lines.push(`  Dashboard quota: unavailable (${detail}) — sign in with cursor-agent`);
  }

  return `${lines.join("\n")}\n`;
}

function overrideCommand(spec: string | undefined): string {
  ensureLlmConfig();
  const db = openLlmDb();
  if (!spec || spec === "off") {
    setState(db, "override_until", "");
    return "Override cleared. Limits will be enforced again.\n";
  }
  const ms = parseDuration(spec);
  if (ms == null) {
    throw new Error("Override duration must look like 15m, 30m, 1h, or off");
  }
  const until = new Date(Date.now() + ms);
  setState(db, "override_until", until.toISOString());
  return `Override active until ${until.toLocaleString()}.\n`;
}

function exceptCommand(args: string[], home = homedir()): string {
  const config = ensureLlmConfig(home);
  const [actionOrId, maybeId] = args;
  if (!actionOrId || actionOrId === "list") {
    return formatList(config.excludeSessionIds);
  }
  if (actionOrId === "remove" || actionOrId === "rm") {
    const id = maybeId?.trim() ?? "";
    if (!id) throw new Error("Usage: llm-budget except remove <session-id>");
    const next = config.excludeSessionIds.filter((existing) => existing !== id);
    writeLlmConfig({ ...config, excludeSessionIds: next }, home);
    return next.length === config.excludeSessionIds.length
      ? `No exception for ${id}.\n`
      : `Removed exception for ${id}.\n${formatList(next)}`;
  }
  if (actionOrId.startsWith("-")) {
    throw new Error(
      "Usage: llm-budget except add <session-id>\n       llm-budget except remove <session-id>\n       llm-budget except list",
    );
  }
  const id = (actionOrId === "add" ? (maybeId ?? "") : actionOrId).trim();
  if (!id || (actionOrId === "add" && !maybeId) || id.startsWith("-")) {
    throw new Error("Usage: llm-budget except add <session-id>");
  }
  if (config.excludeSessionIds.includes(id)) {
    return `Already excepted: ${id}\n${formatList(config.excludeSessionIds)}`;
  }
  const next = [...config.excludeSessionIds, id];
  writeLlmConfig({ ...config, excludeSessionIds: next }, home);
  return `Excepted ${id}. It will bypass every gate.\n${formatList(next)}`;
}

function formatList(ids: string[]): string {
  if (ids.length === 0) return "No session exceptions.\n";
  return `Session exceptions (${ids.length}):\n${ids.map((id) => `  ${id}`).join("\n")}\n`;
}

function formatInstallState(installed: boolean, installCommand: string): string {
  return installed ? "installed" : `not installed — run ${installCommand}`;
}

function installAll(home = homedir()): string {
  const sections = [installClaudeHooks(home), installCodexShim(home), cursorInstallCommand(home)];
  return `${sections.map((section) => section.trimEnd()).join("\n\n")}\n`;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const argv = process.argv.slice(2);
  if (argv[0] === "claude" && argv[1] === "hook") {
    // Unreadable stdin / unexpected crash must fail closed: Claude Code always
    // sends JSON, so silence or garbage means something upstream is broken.
    const detail =
      error instanceof ClaudeHookInputError
        ? message
        : `unexpected hook failure: ${message}`;
    blockClaudeHook(
      "UserPromptSubmit",
      [
        "llm-budget could not verify your budget:",
        `  ${detail}`,
        "",
        "Blocked because enforcement.failClosed is on (the default).",
        "",
        "Recover with:",
        "  llm-budget override 30m",
        "  llm-budget status",
      ].join("\n"),
    );
    return;
  }
  if (argv[0] === "codex-guard" || argv[0] === "watchdog") {
    // The shim treats any non-zero exit as blocked: failing closed.
    process.stderr.write(`llm-budget ${argv[0]} failed: ${message}\n`);
    process.exit(2);
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
