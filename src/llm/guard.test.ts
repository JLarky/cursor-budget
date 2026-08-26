import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, type LlmConfig } from "./config.js";
import { runGuard } from "./guard.js";
import type { UsageSnapshot } from "./usage/index.js";
import { tempHome } from "../test-home.js";

function config(overrides: {
  claudeEnabled?: boolean;
  codexEnabled?: boolean;
  codexOpenAiBlockAt?: number | null;
  failClosed?: boolean;
}): LlmConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  if (overrides.claudeEnabled !== undefined) c.claudeCode.enabled = overrides.claudeEnabled;
  if (overrides.codexEnabled !== undefined) c.codex.enabled = overrides.codexEnabled;
  if (overrides.codexOpenAiBlockAt !== undefined)
    c.codex.openAiWeeklyBlockAtPercent = overrides.codexOpenAiBlockAt;
  if (overrides.failClosed !== undefined) c.enforcement.failClosed = overrides.failClosed;
  return c;
}

function snapshot(
  providers: Array<{
    providerId: string;
    status?: "available" | "unavailable" | "error";
    windows?: Array<{ id: string; label: string; usedPct?: number | null; resetsAt?: string | null }>;
    error?: string | null;
  }>,
): UsageSnapshot {
  return {
    fetchedAt: "2026-08-25T00:00:00.000Z",
    providers: providers.map((p) => ({
      providerId: p.providerId,
      displayName: p.providerId,
      status: p.status ?? ("available" as const),
      planLabel: null,
      windows: (p.windows ?? []).map((w) => ({
        id: w.id,
        label: w.label,
        usedPct: w.usedPct ?? null,
        resetsAt: w.resetsAt ?? null,
      })),
      error: p.error ?? null,
    })),
  };
}

const CLAUDE_SNAPSHOT = () =>
  snapshot([
    {
      providerId: "claude",
      windows: [
        { id: "weekly", label: "Weekly", usedPct: 10, resetsAt: "2026-08-31T00:00:00.000Z" },
        { id: "five_hour", label: "Session", usedPct: 5 },
      ],
    },
  ]);

test("disabled agents short-circuit before any usage fetch", async () => {
  let fetchCalls = 0;
  const decision = await runGuard("codex", config({ codexEnabled: false }), {
    fetchUsage: () => {
      fetchCalls += 1;
      throw new Error("must not fetch for disabled agents");
    },
  });
  assert.equal(decision.allow, true);
  assert.equal(fetchCalls, 0);
});

test("claude gates on weekly and 5h windows", async () => {
  const decision = await runGuard("claude", config({}), { fetchUsage: CLAUDE_SNAPSHOT });
  assert.equal(decision.allow, true);

  const over = snapshot([
    {
      providerId: "claude",
      windows: [
        { id: "weekly", label: "Weekly", usedPct: 85 },
        { id: "five_hour", label: "Session", usedPct: 5 },
      ],
    },
  ]);
  const denied = await runGuard("claude", config({}), { fetchUsage: () => over });
  assert.equal(denied.allow, false);
  const reason = denied.evaluation.reasons[0];
  assert.equal(reason.windowLabel, "Weekly");
  assert.equal(reason.usedPct, 85);
  assert.equal(reason.blockAtPct, 80);
  assert.equal(reason.resetsAt, null);
});

test("codex gates on the OpenAI session window with threshold override", async () => {
  const codex = () =>
    snapshot([
      {
        providerId: "codex",
        windows: [{ id: "session", label: "Session", usedPct: 2, resetsAt: "2026-08-31T16:04:13.000Z" }],
      },
    ]);

  const allowed = await runGuard("codex", config({}), { fetchUsage: codex });
  assert.equal(allowed.allow, true);

  // current + 1 percent headroom, then current - 1: the literal ±1 test.
  const tight = await runGuard("codex", config({ codexOpenAiBlockAt: 3 }), { fetchUsage: codex });
  assert.equal(tight.allow, true);

  const denied = await runGuard("codex", config({ codexOpenAiBlockAt: 1 }), { fetchUsage: codex });
  assert.equal(denied.allow, false);
  const reason = denied.evaluation.reasons[0];
  assert.equal(reason.windowLabel, "Weekly (OpenAI)");
  assert.equal(reason.usedPct, 2);
  assert.equal(reason.blockAtPct, 1);
  assert.equal(reason.resetsAt, "2026-08-31T16:04:13.000Z");
});

test("unreachable usage API fails closed with a reason", async () => {
  const decision = await runGuard("codex", config({}), {
    fetchUsage: () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.evaluation.reasons[0]?.windowId, "usageUnknown");
  assert.match(decision.evaluation.reasons[0]?.detail ?? "", /Could not fetch codex usage/);
});

test("fail-open configs allow when usage is unknown", async () => {
  const decision = await runGuard("codex", config({ failClosed: false }), {
    fetchUsage: () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  assert.equal(decision.allow, true);
});

test("missing provider entry or windows count as unknown usage", async () => {
  const noEntry = await runGuard("codex", config({}), { fetchUsage: () => snapshot([]) });
  assert.equal(noEntry.allow, false);
  assert.match(noEntry.evaluation.reasons[0]?.detail ?? "", /No codex usage entry/);

  const noWindows = await runGuard("codex", config({}), {
    fetchUsage: () =>
      snapshot([{ providerId: "codex", status: "unavailable", error: "not signed in" }]),
  });
  assert.equal(noWindows.allow, false);
  assert.match(noWindows.evaluation.reasons[0]?.detail ?? "", /unavailable — not signed in/);
});

test("a missing gate window is unknown usage, not a pass", async () => {
  const partial = snapshot([
    {
      providerId: "claude",
      windows: [{ id: "weekly", label: "Weekly", usedPct: 10 }],
    },
  ]);
  const decision = await runGuard("claude", config({}), { fetchUsage: () => partial });
  assert.equal(decision.allow, false);
  assert.match(decision.evaluation.reasons[0]?.detail ?? "", /claudeRolling/);
});

test("override and exceptions bypass every gate", async () => {
  const over = snapshot([
    {
      providerId: "codex",
      windows: [{ id: "session", label: "Session", usedPct: 99 }],
    },
  ]);
  const overridden = await runGuard("codex", config({ codexOpenAiBlockAt: 50 }), {
    fetchUsage: () => over,
    now: new Date(),
  });
  // No override stored in this temp home — still blocked.
  assert.equal(overridden.allow, false);

  const excluded = await runGuard("codex", config({ codexOpenAiBlockAt: 50 }), {
    fetchUsage: () => over,
    sessionId: "sess-exempt",
  });
  assert.equal(excluded.allow, false); // not registered yet

  // Register the exception through the same store the guard reads.
  const home = tempHome("llm-budget-guard-exc-");
  const cfg = structuredClone(config({ codexOpenAiBlockAt: 50 }));
  cfg.excludeSessionIds = ["sess-exempt"];
  const exempted = await runGuard("codex", cfg, {
    home,
    fetchUsage: () => over,
    sessionId: "sess-exempt",
  });
  assert.equal(exempted.allow, true);
});

test("claude weekly window uses the normalized vendor id", async () => {
  const forkNaming = snapshot([
    {
      providerId: "claude",
      windows: [
        { id: "weekly", label: "Weekly", usedPct: 85 },
        { id: "five_hour", label: "Session", usedPct: 5 },
      ],
    },
  ]);
  const denied = await runGuard("claude", config({}), { fetchUsage: () => forkNaming });
  assert.equal(denied.allow, false);
  assert.equal(denied.evaluation.reasons[0]?.windowLabel, "Weekly");

  const allowed = await runGuard("claude", config({}), { fetchUsage: CLAUDE_SNAPSHOT });
  assert.equal(allowed.allow, true);
});
