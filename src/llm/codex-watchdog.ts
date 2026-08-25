import { spawnSync } from "node:child_process";
import { ensureLlmConfig, loadLlmConfigForRead, type LlmConfig } from "./config.js";
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
  /** Injectable desktop notification (tests). */
  notifyFn?: (title: string, body: string) => void;
}

export interface WatchdogPassResult {
  blocked: boolean;
  killedPids: number[];
}

/**
 * Sidecar poller that stops already-running Codex sessions once the weekly
 * budget trips.
 *
 * The shim only gates *starting* Codex — it cannot reach inside a running
 * turn. This loop re-evaluates every few seconds and SIGTERMs codex processes
 * every poll while the budget remains exceeded, so a process that started
 * later through an absolute path (bypassing the shim) or shrugged off the
 * first SIGTERM is still caught. The trip latch only gates the desktop
 * notification/log transition so one trip doesn't spam; it clears when usage
 * drops back under the threshold (override/exception/reset).
 */
export async function runWatchdog(deps: WatchdogDeps = {}): Promise<WatchdogPassResult | null> {
  const home = deps.home;
  const intervalMs = deps.intervalMs ?? 15_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (;;) {
    const pass = await watchdogPass({ ...deps, home });
    if (deps.once) return pass;
    await sleep(intervalMs);
  }
}

async function watchdogPass(
  deps: WatchdogDeps & { home?: string },
): Promise<WatchdogPassResult & { notified: boolean }> {
  const { home } = deps;
  const now = deps.now ?? new Date();
  const db = openLlmDb(home);
  const log = deps.log ?? (() => {});
  const notifyFn = deps.notifyFn ?? notify;

  // Config must be strict here: an unreadable config is exactly when a guard
  // must not silently stop guarding. Under failClosed that means treat every
  // codex process as over-budget; with failClosed off, sit this pass out.
  let decision: Pick<GuardDecision, "allow" | "evaluation" | "sessionId"> & {
    config: LlmConfig;
  };
  try {
    decision = deps.decide
      ? deps.decide()
      : await runGuard("codex", ensureLlmConfig(home), { now });
  } catch (error) {
    const lenient = loadLlmConfigForRead(home).config.enforcement.failClosed === false;
    if (!lenient) {
      const targets = (deps.listCodexProcesses ?? defaultListCodexProcesses)().filter(
        ({ pid }) => pid !== process.pid,
      );
      const kill = deps.kill ?? defaultKill;
      const killedPids: number[] = [];
      for (const target of targets) {
        if (kill(target.pid)) killedPids.push(target.pid);
      }
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `llm-budget failed closed: config unreadable, stopping Codex sessions.\n  ${detail}\n`,
      );
      notifyFn("llm-budget", "llm-budget config unreadable — Codex sessions stopped (fail-closed).");
      log(`config error; killed ${killedPids.length} codex process(es)`);
      return { blocked: true, killedPids, notified: true };
    }
    log("config unreadable; failClosed is off — skipping this pass");
    return { blocked: false, killedPids: [], notified: false };
  }

  if (!decision.allow) {
    const firstTrip = getState(db, "codex_watchdog_trip") !== "active";
    setState(db, "codex_watchdog_trip", "active");

    // Kill on EVERY tripped pass: new codex processes can appear mid-trip
    // (shim bypass) and survivors of a previous SIGTERM may still be alive.
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
    if (firstTrip) {
      notifyFn(
        "llm-budget",
        "Codex weekly budget tripped — running Codex sessions were stopped. Run llm-budget status.",
      );
      log(
        killedPids.length > 0
          ? `killed codex processes: ${killedPids.join(", ")}`
          : "budget tripped but no running codex processes found",
      );
    } else if (killedPids.length > 0) {
      log(`still over budget; killed newly seen codex processes: ${killedPids.join(", ")}`);
    }
    return { blocked: true, killedPids, notified: firstTrip };
  }

  if (getState(db, "codex_watchdog_trip") === "active") {
    setState(db, "codex_watchdog_trip", "");
    log("budget recovered; watchdog re-armed");
  }
  return { blocked: false, killedPids: [], notified: false };
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
    // Never match our own CLI.
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
