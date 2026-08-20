import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CursorApiError,
  CursorUsageUnavailableError,
  type CursorPeriodUsageResult,
} from "./accounting/cursor-api.js";
import { DEFAULT_CONFIG } from "./config.js";
import { hasWarning, openDb } from "./db/client.js";
import { handleHook, resolvePeriodUsage } from "./hook.js";

function fakeResult(
  overrides: Partial<CursorPeriodUsageResult> & {
    autoPercentUsed?: number | null;
    apiPercentUsed?: number | null;
  } = {},
): CursorPeriodUsageResult {
  const auto =
    overrides.autoPercentUsed === undefined ? 1.3 : overrides.autoPercentUsed;
  const api = overrides.apiPercentUsed === undefined ? 0.5 : overrides.apiPercentUsed;
  const fetchedAt = overrides.fetchedAt ?? new Date("2026-08-19T12:00:00.000Z");
  return {
    usage: {
      billingCycleStart: new Date("2026-08-01T00:00:00.000Z"),
      billingCycleEnd: new Date("2026-09-01T00:00:00.000Z"),
      planUsage: {
        totalSpendCents: 2596,
        includedSpendCents: 2596,
        bonusSpendCents: 0,
        remainingCents: 37404,
        limitCents: 40000,
        totalSpendUsd: 25.96,
        includedSpendUsd: 25.96,
        bonusSpendUsd: 0,
        remainingUsd: 374.04,
        limitUsd: 400,
        autoPercentUsed: auto,
        apiPercentUsed: api,
        totalPercentUsed: 1.0,
        remainingBonus: false,
        bonusTooltip: null,
      },
      spendLimitUsage: {
        limitType: null,
        totalSpendCents: null,
        individualLimitCents: null,
        individualUsedCents: null,
        individualRemainingCents: null,
        pooledLimitCents: null,
        pooledUsedCents: null,
        pooledRemainingCents: null,
      },
      displayThreshold: null,
      enabled: true,
      displayMessage: null,
      autoModelSelectedDisplayMessage: null,
      namedModelSelectedDisplayMessage: null,
      autoBucketModels: [],
    },
    source: overrides.source ?? "network",
    fetchedAt,
    ageMs: overrides.ageMs ?? 0,
    stale: overrides.stale ?? false,
    refreshError: overrides.refreshError,
  };
}

test("invalid config.json denies enforce events instead of failing open", async () => {
  const home = mkdtempSync(join(tmpdir(), "cursor-budget-hook-"));
  try {
    mkdirSync(join(home, ".cursor", "llm-budget"), { recursive: true });
    writeFileSync(
      join(home, ".cursor", "llm-budget", "config.json"),
      `${JSON.stringify({
        quota: { cursorModelsBlockAtPercent: "ninety" },
      })}\n`,
    );
    const response = await handleHook(
      {
        hook_event_name: "preToolUse",
        conversation_id: "sess-bad-config",
      },
      undefined,
      { home },
    );
    assert.equal(response.permission, "deny");
    assert.equal(response.continue, false);
    assert.match(String(response.user_message), /failed to load config/);
    assert.match(String(response.user_message), /Session id: sess-bad-config/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("invalid config.json still allows non-enforce record events", async () => {
  const home = mkdtempSync(join(tmpdir(), "cursor-budget-hook-rec-"));
  try {
    mkdirSync(join(home, ".cursor", "llm-budget"), { recursive: true });
    writeFileSync(join(home, ".cursor", "llm-budget", "config.json"), "{not-json");
    const response = await handleHook(
      {
        hook_event_name: "afterAgentThought",
        conversation_id: "sess-record",
      },
      undefined,
      { home },
    );
    assert.equal(response.permission, "allow");
    assert.equal(response.continue, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("§5 network/cache sources gate normally", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.quota.cursorModelsBlockAtPercent = 90;
  for (const source of ["network", "cache"] as const) {
    const response = await handleHook(
      { hook_event_name: "preToolUse", conversation_id: "sess-gate" },
      config,
      {
        getPeriodUsage: async () => fakeResult({ source, autoPercentUsed: 95 }),
      },
    );
    assert.equal(response.permission, "deny", source);
  }
});

test("§5 stale-cache within maxStaleMs gates normally", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.quota.cursorModelsBlockAtPercent = 90;
  config.quota.maxStaleMs = 3_600_000;
  const response = await handleHook(
    { hook_event_name: "preToolUse", conversation_id: "sess-stale-ok" },
    config,
    {
      getPeriodUsage: async () =>
        fakeResult({
          source: "stale-cache",
          stale: true,
          ageMs: 60_000,
          autoPercentUsed: 95,
        }),
    },
  );
  assert.equal(response.permission, "deny");
  assert.match(String(response.user_message), /stale/);
});

test("§5 stale-cache beyond maxStaleMs fails open", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.quota.cursorModelsBlockAtPercent = 90;
  config.quota.maxStaleMs = 60_000;
  const response = await handleHook(
    { hook_event_name: "preToolUse", conversation_id: "sess-stale-old" },
    config,
    {
      getPeriodUsage: async () =>
        fakeResult({
          source: "stale-cache",
          stale: true,
          ageMs: 120_000,
          autoPercentUsed: 99,
        }),
    },
  );
  assert.equal(response.permission, "allow");
});

test("§5 CursorUsageUnavailableError fails open unless failClosed", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.quota.cursorModelsBlockAtPercent = 1;
  const open = await handleHook(
    { hook_event_name: "preToolUse", conversation_id: "sess-unavail" },
    config,
    {
      getPeriodUsage: async () => {
        throw new CursorUsageUnavailableError("no cache");
      },
    },
  );
  assert.equal(open.permission, "allow");

  config.enforcement.failClosed = true;
  const closed = await handleHook(
    { hook_event_name: "preToolUse", conversation_id: "sess-unavail-closed" },
    config,
    {
      getPeriodUsage: async () => {
        throw new CursorUsageUnavailableError("no cache");
      },
    },
  );
  assert.equal(closed.permission, "deny");
  assert.match(String(closed.user_message), /failed closed/);
});

test("§5 HTTP 401 fails open with re-auth message", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.quota.cursorModelsBlockAtPercent = 1;
  const response = await handleHook(
    { hook_event_name: "preToolUse", conversation_id: "sess-401" },
    config,
    {
      getPeriodUsage: async () => {
        throw new CursorUsageUnavailableError(
          "no cache",
          new CursorApiError(401, "unauthorized"),
        );
      },
    },
  );
  assert.equal(response.permission, "allow");
  assert.match(String(response.user_message), /cursor-agent/);
});

test("§5 null percent field does not block", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.quota.cursorModelsBlockAtPercent = 90;
  const response = await handleHook(
    { hook_event_name: "preToolUse", conversation_id: "sess-null-pct" },
    config,
    {
      getPeriodUsage: async () =>
        fakeResult({ autoPercentUsed: null, apiPercentUsed: 1 }),
    },
  );
  assert.equal(response.permission, "allow");
});

test("event-count backstop blocks when over threshold", async () => {
  const home = mkdtempSync(join(tmpdir(), "cursor-budget-events-"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.rateLimit.maxEventsPerHour = 2;
    // Seed two events via beforeSubmitPrompt record path on allow, then block on third enforce.
    const deps = {
      home,
      getPeriodUsage: async () => fakeResult({ autoPercentUsed: 1 }),
    };
    await handleHook(
      {
        hook_event_name: "beforeSubmitPrompt",
        conversation_id: "sess-rate",
        prompt: "one",
        generation_id: "g1",
      },
      config,
      deps,
    );
    await handleHook(
      {
        hook_event_name: "beforeSubmitPrompt",
        conversation_id: "sess-rate",
        prompt: "two",
        generation_id: "g2",
      },
      config,
      deps,
    );
    const blocked = await handleHook(
      { hook_event_name: "preToolUse", conversation_id: "sess-rate" },
      config,
      deps,
    );
    assert.equal(blocked.permission, "deny");
    assert.match(String(blocked.user_message), /event rate/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("override and except bypass both gates", async () => {
  const home = mkdtempSync(join(tmpdir(), "cursor-budget-bypass-"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.quota.cursorModelsBlockAtPercent = 1;
    config.rateLimit.maxEventsPerHour = 0;
    const deps = {
      home,
      getPeriodUsage: async () => fakeResult({ autoPercentUsed: 99 }),
    };

    const excepted = structuredClone(config);
    excepted.excludeConversationIds = ["sess-except"];
    const exceptResp = await handleHook(
      { hook_event_name: "preToolUse", conversation_id: "sess-except" },
      excepted,
      deps,
    );
    assert.equal(exceptResp.permission, "allow");

    const db = openDb(home);
    db.prepare(
      "INSERT INTO app_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run("override_until", new Date(Date.now() + 60_000).toISOString());
    const overrideResp = await handleHook(
      { hook_event_name: "preToolUse", conversation_id: "sess-over" },
      config,
      deps,
    );
    assert.equal(overrideResp.permission, "allow");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("warnings fire once per threshold per billing cycle", async () => {
  const home = mkdtempSync(join(tmpdir(), "cursor-budget-warn-"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.quota.cursorModelsBlockAtPercent = 100;
    config.warnings = [0.5];
    const periodUsage = fakeResult({ autoPercentUsed: 60 });
    const deps = {
      home,
      getPeriodUsage: async () => periodUsage,
    };
    await handleHook(
      { hook_event_name: "preToolUse", conversation_id: "sess-warn" },
      config,
      deps,
    );
    await handleHook(
      { hook_event_name: "preToolUse", conversation_id: "sess-warn" },
      config,
      deps,
    );
    const db = openDb(home);
    const periodKey = periodUsage.usage.billingCycleEnd!.toISOString();
    assert.equal(hasWarning(db, "cursorModels", 0.5, periodKey), true);
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM warning_emissions WHERE window_id = ?")
      .get("cursorModels") as { n: number | bigint };
    assert.equal(Number(rows.n), 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolvePeriodUsage marks too-stale as null", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.quota.maxStaleMs = 10_000;
  const { periodUsage } = await resolvePeriodUsage(config, {
    getPeriodUsage: async () =>
      fakeResult({ source: "stale-cache", stale: true, ageMs: 999_999 }),
  });
  assert.equal(periodUsage, null);
});
