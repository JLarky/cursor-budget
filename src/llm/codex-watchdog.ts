import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { ensureLlmConfig, type LlmConfig } from "./config.js";
import { getState, openLlmDb, setState } from "./db.js";
import { runGuard, formatGuardDeny } from "./guard.js";
import { notify } from "../notify.js";
import type { GuardDecision } from "./guard.js";

export interface WatchdogDeps {
  home?: string;
  now?: Date;
  /** Poll interval in ms (default 15s). */
  intervalMs?: number;
  /** Run a single pass and return (tests / `--once`). */
  once?: boolean;
  /** Injectable decision source; defaults to runGuard("codex"). */
  decide?: () => Pick<GuardDecision, "allow" | "evaluation" | "sessionId"> & {
    config: LlmConfig;
  };
  /** Injectable process list; returns [pid, command line]. */
  listCodexProcesses?: () => Array<{ pid: number; command: string }>;
  kill?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface WatchdogPassResult {
  blocked: boolean;
  killedPids: number[];
}

/**
 * Sidecar poller that stops an already-running Codex session once the weekly
 * budget trips.
 *
 * The shim only gates *starting* Codex — it cannot reach inside a running
 * turn. This loop re-evaluates every few seconds and SIGTERMs codex
 * processes when the budget trips. Kills are latched per UTC week so one trip
 * doesn't become a kill loop; the latch clears when usage drops back under
 * the threshold (override/exception/reset).
 */
export async function runWatchdog(deps: WatchdogDeps = {}): Promise<WatchdogPassResult | null> {
  const home = deps.home;
  const config = ensureLlmConfig(home);
  const intervalMs = deps.intervalMs ?? 15_000;
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (;;) {
    const pass = await watchdogPass({ ...deps, home, config });
    if (pass.blocked && pass.killedPids.length > 0) {
      notify(
        "llm-budget",
        "Codex weekly budget tripped — running Codex sessions were stopped. Run llm-budget status.",
      );
    }
    if (deps.once) return pass;
    await sleep(intervalMs);
  }
}

async function watchdogPass(deps: WatchdogDeps & { config: LlmConfig }): Promise<WatchdogPassResult> {
  const { home, config } = deps;
  const now = deps.now ?? new Date();
  const db = openLlmDb(home);

  const decide =
    deps.decide ??
    (() => {
      const decision = runGuard("codex", config, { home, now });
      return decision;
    });

  const decision = decide();

  if (!decision.allow) {
    const latch = getState(db, "codex_watchdog_trip");
    if (latch === "active") {
      return { blocked: true, killedPids: [] };
    }
    setState(db, "codex_watchdog_trip", "active");

    const targets = (deps.listCodexProcesses ?? defaultListCodexProcesses)().filter(
      ({ pid }) => pid !== process.pid,
    );
    const kill = deps.kill ?? defaultKill;
    const killedPids: number[] = [];
    for (const target of targets) {
      if (kill(target.pid)) killedPids.push(target.pid);
    }

    // Print the same block message the shim would have shown.
    process.stderr.write(
      `${formatGuardDeny(decision as GuardDecision, "codex", decision.sessionId)}\n`,
    );
    (deps.log ?? (() => {}))(
      killedPids.length > 0
        ? `killed codex processes: ${killedPids.join(", ")}`
        : "budget tripped but no running codex processes found",
    );
    return { blocked: true, killedPids };
  }

  if (getState(db, "codex_watchdog_trip") === "active") {
    setState(db, "codex_watchdog_trip", "");
    (deps.log ?? (() => {}))("budget recovered; watchdog re-armed");
  }
  return { blocked: false, killedPids: [] };
}

/** `ps` scan for processes whose args reference a codex binary. */
export function defaultListCodexProcesses(): Array<{ pid: number; command: string }> {
  const result = spawnSync("ps", ["-eo", "pid=", "-o", "args="], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return [];
  const out: Array<{ pid: number; command: string }> = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx <= 0) continue;
    const pid = Number(trimmed.slice(0, spaceIdx));
    const command = trimmed.slice(spaceIdx + 1).trim();
    if (!Number.isInteger(pid)) continue;
    if (!/(^|\/)(codex)(\s|$)/.test(command)) continue;
    // Never match our own CLI (it embeds "llm-budget", not plain codex, but be safe).
    if (command.includes("llm-budget")) continue;
    out.push({ pid, command });
  }
  return out;
}

function defaultKill(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
