import assert from "node:assert/strict";
import test from "node:test";
import type {
  CursorPeriodUsage,
  CursorPeriodUsageResult,
} from "../accounting/cursor-api.js";
import { DEFAULT_CONFIG } from "../config.js";
import { evaluate, formatBlockMessage, formatUsd } from "./evaluator.js";

function fakeUsage(overrides: {
  autoPercentUsed?: number | null;
  apiPercentUsed?: number | null;
  totalPercentUsed?: number | null;
  totalSpendUsd?: number;
  limitUsd?: number | null;
  billingCycleEnd?: Date | null;
}): CursorPeriodUsage {
  const auto =
    overrides.autoPercentUsed === undefined ? 1.3 : overrides.autoPercentUsed;
  const api = overrides.apiPercentUsed === undefined ? 0.5 : overrides.apiPercentUsed;
  const total =
    overrides.totalPercentUsed === undefined ? 1.0 : overrides.totalPercentUsed;
  const spendUsd = overrides.totalSpendUsd ?? 25.96;
  const limitUsd = overrides.limitUsd === undefined ? 400 : overrides.limitUsd;
  return {
    billingCycleStart: new Date("2026-08-01T00:00:00.000Z"),
    billingCycleEnd:
      overrides.billingCycleEnd === undefined
        ? new Date("2026-09-01T00:00:00.000Z")
        : overrides.billingCycleEnd,
    planUsage: {
      totalSpendCents: Math.round(spendUsd * 100),
      includedSpendCents: Math.round(spendUsd * 100),
      bonusSpendCents: 0,
      remainingCents: limitUsd == null ? null : Math.round((limitUsd - spendUsd) * 100),
      limitCents: limitUsd == null ? null : Math.round(limitUsd * 100),
      totalSpendUsd: spendUsd,
      includedSpendUsd: spendUsd,
      bonusSpendUsd: 0,
      remainingUsd: limitUsd == null ? null : limitUsd - spendUsd,
      limitUsd,
      autoPercentUsed: auto,
      apiPercentUsed: api,
      totalPercentUsed: total,
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
  };
}

function fakeResult(
  usageOverrides: Parameters<typeof fakeUsage>[0] = {},
  meta: Partial<CursorPeriodUsageResult> = {},
): CursorPeriodUsageResult {
  const fetchedAt = meta.fetchedAt ?? new Date("2026-08-19T12:00:00.000Z");
  return {
    usage: fakeUsage(usageOverrides),
    source: meta.source ?? "network",
    fetchedAt,
    ageMs: meta.ageMs ?? 0,
    stale: meta.stale ?? false,
    refreshError: meta.refreshError,
  };
}

test("unset rate limit and low quota never block", () => {
  const decision = evaluate({
    periodUsage: fakeResult({ autoPercentUsed: 1.3, apiPercentUsed: 0.5 }),
    eventsLastHour: 500,
    config: DEFAULT_CONFIG,
    overrideUntil: null,
  });
  assert.equal(decision.allow, true);
  assert.equal(decision.reasons.length, 0);
});

test("cursor models percent blocks at threshold", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.quota.cursorModelsBlockAtPercent = 90;
  const decision = evaluate({
    periodUsage: fakeResult({ autoPercentUsed: 90 }),
    eventsLastHour: 0,
    config,
    overrideUntil: null,
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.reasons[0]?.metric, "cursorModelsPercent");
});

test("null percent field does not block (absent is not zero)", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.quota.cursorModelsBlockAtPercent = 90;
  config.quota.otherModelsBlockAtPercent = 90;
  const decision = evaluate({
    periodUsage: fakeResult({ autoPercentUsed: null, apiPercentUsed: 1 }),
    eventsLastHour: 0,
    config,
    overrideUntil: null,
  });
  assert.equal(decision.allow, true);
  assert.equal(decision.reasons.length, 0);
});

test("unknown usage blocks by default (failClosed is on)", () => {
  const decision = evaluate({
    periodUsage: null,
    usageUnknownReason: "Cursor auth expired or missing.",
    eventsLastHour: 0,
    config: DEFAULT_CONFIG,
    overrideUntil: null,
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.reasons[0]?.metric, "usageUnknown");
  assert.match(decision.reasons[0]?.detail ?? "", /auth expired/);
});

test("unknown usage allows when failClosed is turned off", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.enforcement.failClosed = false;
  config.quota.cursorModelsBlockAtPercent = 1;
  const decision = evaluate({
    periodUsage: null,
    usageUnknownReason: "network down",
    eventsLastHour: 0,
    config,
    overrideUntil: null,
  });
  assert.equal(decision.allow, true);
});

test("unknown usage still yields to override", () => {
  const decision = evaluate({
    periodUsage: null,
    usageUnknownReason: "network down",
    eventsLastHour: 0,
    config: DEFAULT_CONFIG,
    overrideUntil: new Date(Date.now() + 60_000),
  });
  assert.equal(decision.allow, true);
  assert.equal(decision.overrideActive, true);
});

test("unknown usage still yields to an excepted conversation", () => {
  const decision = evaluate({
    periodUsage: null,
    usageUnknownReason: "network down",
    eventsLastHour: 0,
    config: DEFAULT_CONFIG,
    overrideUntil: null,
    excluded: true,
  });
  assert.equal(decision.allow, true);
  assert.equal(decision.excluded, true);
});

test("block message explains why usage is unknown", () => {
  const decision = evaluate({
    periodUsage: null,
    usageUnknownReason: "cached snapshot is 3.0h old (max 1.0h)",
    eventsLastHour: 0,
    config: DEFAULT_CONFIG,
    overrideUntil: null,
  });
  const message = formatBlockMessage(decision, null, 0, DEFAULT_CONFIG, "abc");
  assert.match(message, /could not be determined/);
  assert.match(message, /3\.0h old/);
  assert.match(message, /failClosed/);
  assert.match(message, /cursor-budget override 30m/);
});

test("event-count backstop: under threshold allows", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  // Isolate the backstop: without this, null usage would block on its own.
  config.enforcement.failClosed = false;
  config.rateLimit.maxEventsPerHour = 100;
  const decision = evaluate({
    periodUsage: null,
    eventsLastHour: 99,
    config,
    overrideUntil: null,
  });
  assert.equal(decision.allow, true);
});

test("event-count backstop: at threshold blocks", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.enforcement.failClosed = false;
  config.rateLimit.maxEventsPerHour = 100;
  const decision = evaluate({
    periodUsage: null,
    eventsLastHour: 100,
    config,
    overrideUntil: null,
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.reasons[0]?.metric, "eventRate");
});

test("override bypasses both quota and event-rate gates", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.quota.cursorModelsBlockAtPercent = 1;
  config.rateLimit.maxEventsPerHour = 1;
  const until = new Date(Date.now() + 60_000);
  const decision = evaluate({
    periodUsage: fakeResult({ autoPercentUsed: 99 }),
    eventsLastHour: 500,
    config,
    overrideUntil: until,
  });
  assert.equal(decision.allow, true);
  assert.equal(decision.overrideActive, true);
});

test("excluded conversation bypasses both gates", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.quota.cursorModelsBlockAtPercent = 1;
  config.rateLimit.maxEventsPerHour = 1;
  const decision = evaluate({
    periodUsage: fakeResult({ autoPercentUsed: 99 }),
    eventsLastHour: 500,
    config,
    overrideUntil: null,
    excluded: true,
  });
  assert.equal(decision.allow, true);
  assert.equal(decision.excluded, true);
});

test("block message includes session id and real spend", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.quota.cursorModelsBlockAtPercent = 90;
  const periodUsage = fakeResult({ autoPercentUsed: 95, totalSpendUsd: 25.96, limitUsd: 400 });
  const decision = evaluate({
    periodUsage,
    eventsLastHour: 3,
    config,
    overrideUntil: null,
  });
  const message = formatBlockMessage(
    decision,
    periodUsage,
    3,
    config,
    "21623392-2ebe-4a2a-b906-e012529de912",
  );
  assert.match(message, /Session id: 21623392-2ebe-4a2a-b906-e012529de912/);
  assert.match(message, /cursor-budget except add 21623392-2ebe-4a2a-b906-e012529de912/);
  assert.match(message, /\$25\.96 \/ \$400\.00/);
  assert.doesNotMatch(message, /estimated/i);
});

test("block message notes stale snapshot age", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.quota.cursorModelsBlockAtPercent = 90;
  const periodUsage = fakeResult(
    { autoPercentUsed: 95 },
    { source: "stale-cache", stale: true, ageMs: 120_000 },
  );
  const decision = evaluate({
    periodUsage,
    eventsLastHour: 0,
    config,
    overrideUntil: null,
  });
  const message = formatBlockMessage(decision, periodUsage, 0, config, "abc");
  assert.match(message, /stale/);
  assert.match(message, /2m/);
});

test("formatUsd handles non-finite and sub-cent values", () => {
  assert.equal(formatUsd(Number.NaN), "$?—");
  assert.equal(formatUsd(0.006), "$0.006");
  assert.equal(formatUsd(1.5), "$1.50");
});
