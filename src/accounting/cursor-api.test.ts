import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { openDb } from "../db/client.js";
import { tempHome } from "../test-home.js";
import {
  CursorApiError,
  CursorAuthError,
  CursorParseError,
  CursorTimeoutError,
  CursorUsageUnavailableError,
  fetchCursorPeriodUsage,
  getCursorPeriodUsage,
  normalizePeriodUsage,
  parseCursorTimestamp,
  resolveAccessToken,
  tokenExpiry,
  writeCachedPeriodUsage,
} from "./cursor-api.js";

const sampleRaw = {
  billingCycleStart: "1787023611000",
  billingCycleEnd: "1789702011000",
  planUsage: {
    totalSpend: 2596,
    includedSpend: 2596,
    remaining: 37404,
    limit: 40000,
    remainingBonus: false,
    bonusTooltip: "bonus tip",
    autoPercentUsed: 1.298,
    apiPercentUsed: 0,
    totalPercentUsed: 1.0384,
  },
  spendLimitUsage: { limitType: "user" },
  displayThreshold: 200,
  enabled: true,
  displayMessage: "You've used 6% of your included usage",
  autoModelSelectedDisplayMessage: "You've used 1% of your included total usage",
  namedModelSelectedDisplayMessage: "You've used 0% of your included API usage",
  autoBucketModels: ["default", "composer-2"],
};

function sampleRawWithSpend(totalSpend: number) {
  return {
    ...sampleRaw,
    planUsage: {
      ...sampleRaw.planUsage,
      totalSpend,
      includedSpend: totalSpend,
      remaining: 40000 - totalSpend,
    },
  };
}

function withTempDb<T>(fn: (db: ReturnType<typeof openDb>, home: string) => Promise<T> | T): Promise<T> {
  const home = tempHome("llm-budget-api-");
  const db = openDb(home);
  return Promise.resolve(fn(db, home)).finally(() => {
    rmSync(home, { recursive: true, force: true });
  });
}

test("parseCursorTimestamp accepts ms strings", () => {
  const d = parseCursorTimestamp("1787023611000");
  assert.ok(d);
  assert.equal(d.toISOString(), "2026-08-18T03:26:51.000Z");
});

test("parseCursorTimestamp returns null for absent values", () => {
  assert.equal(parseCursorTimestamp(undefined), null);
  assert.equal(parseCursorTimestamp(null), null);
  assert.equal(parseCursorTimestamp(""), null);
  assert.equal(parseCursorTimestamp("not-a-date"), null);
});

test("normalizePeriodUsage maps dashboard meters and USD", () => {
  const usage = normalizePeriodUsage(sampleRaw);
  assert.equal(usage.planUsage.autoPercentUsed, 1.298);
  assert.equal(usage.planUsage.apiPercentUsed, 0);
  assert.equal(usage.planUsage.totalPercentUsed, 1.0384);
  assert.equal(usage.planUsage.totalSpendUsd, 25.96);
  assert.equal(usage.planUsage.limitUsd, 400);
  assert.equal(usage.planUsage.remainingUsd, 374.04);
  assert.equal(usage.displayMessage, sampleRaw.displayMessage);
  assert.deepEqual(usage.autoBucketModels, ["default", "composer-2"]);
  assert.equal(usage.spendLimitUsage.limitType, "user");
});

test("renamed or absent percent meters stay null (never silent zero)", () => {
  const usage = normalizePeriodUsage({
    ...sampleRaw,
    planUsage: {
      totalSpend: 39000,
      includedSpend: 39000,
      remaining: 1000,
      limit: 40000,
      cursorModelsPercentUsed: 97.5,
      otherModelsPercentUsed: 12,
    },
  });
  assert.equal(usage.planUsage.autoPercentUsed, null);
  assert.equal(usage.planUsage.apiPercentUsed, null);
  assert.equal(usage.planUsage.totalPercentUsed, null);
  assert.equal(usage.planUsage.totalSpendUsd, 390);
});

test("missing cycle dates do not abort a response with valid percentages", () => {
  const { billingCycleStart: _s, billingCycleEnd: _e, ...rest } = sampleRaw;
  const usage = normalizePeriodUsage(rest);
  assert.equal(usage.billingCycleStart, null);
  assert.equal(usage.billingCycleEnd, null);
  assert.equal(usage.planUsage.autoPercentUsed, 1.298);
  assert.equal(usage.planUsage.apiPercentUsed, 0);
  assert.equal(usage.planUsage.totalPercentUsed, 1.0384);
});

test("non-object body throws CursorParseError (not fake HTTP 200)", () => {
  assert.throws(() => normalizePeriodUsage("oops"), CursorParseError);
  assert.throws(() => normalizePeriodUsage(null), CursorParseError);
});

test("resolveAccessToken prefers explicit option over env", () => {
  const prev = process.env.CURSOR_ACCESS_TOKEN;
  process.env.CURSOR_ACCESS_TOKEN = "from-env";
  try {
    assert.equal(resolveAccessToken({ accessToken: " from-opt " }), "from-opt");
  } finally {
    if (prev === undefined) delete process.env.CURSOR_ACCESS_TOKEN;
    else process.env.CURSOR_ACCESS_TOKEN = prev;
  }
});

test("fetchCursorPeriodUsage uses Bearer fetch and normalizes body", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const usage = await fetchCursorPeriodUsage({
    accessToken: "test-token",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(sampleRaw), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /GetCurrentPeriodUsage$/);
  const headers = new Headers(calls[0]!.init?.headers);
  assert.equal(headers.get("Authorization"), "Bearer test-token");
  assert.equal(headers.get("Connect-Protocol-Version"), "1");
  assert.ok(calls[0]!.init?.signal, "AbortSignal should be passed to fetch");
  assert.equal(usage.planUsage.includedSpendCents, 2596);
});

test("fetchCursorPeriodUsage surfaces HTTP errors", async () => {
  await assert.rejects(
    () =>
      fetchCursorPeriodUsage({
        accessToken: "x",
        fetch: async () => new Response("nope", { status: 401 }),
      }),
    (err: unknown) => err instanceof CursorApiError && err.status === 401,
  );
});

test("fetchCursorPeriodUsage surfaces timeout as CursorTimeoutError via signal.reason", async () => {
  // Mirror real Node fetch: AbortSignal.timeout() aborts with TimeoutError, and
  // fetch rejects with signal.reason — not a hand-built AbortError.
  await assert.rejects(
    () =>
      fetchCursorPeriodUsage({
        accessToken: "x",
        timeoutMs: 20,
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error("expected AbortSignal"));
              return;
            }
            const rejectWithReason = () => {
              reject(signal.reason ?? new DOMException("The operation was aborted.", "TimeoutError"));
            };
            if (signal.aborted) {
              rejectWithReason();
              return;
            }
            signal.addEventListener("abort", rejectWithReason);
          }),
      }),
    (err: unknown) => err instanceof CursorTimeoutError && err.timeoutMs === 20,
  );
});

test("fetchCursorPeriodUsage non-JSON body throws CursorParseError", async () => {
  await assert.rejects(
    () =>
      fetchCursorPeriodUsage({
        accessToken: "x",
        fetch: async () => new Response("not-json", { status: 200 }),
      }),
    CursorParseError,
  );
});

test("resolveAccessToken without sources throws CursorAuthError", () => {
  const prev = process.env.CURSOR_ACCESS_TOKEN;
  delete process.env.CURSOR_ACCESS_TOKEN;
  try {
    assert.throws(
      () => resolveAccessToken({ home: "/tmp/llm-budget-no-auth-home" }),
      CursorAuthError,
    );
  } finally {
    if (prev !== undefined) process.env.CURSOR_ACCESS_TOKEN = prev;
  }
});

test("cache hit avoids a second fetch within TTL", async () => {
  await withTempDb(async (db) => {
    let fetches = 0;
    const fetch: typeof globalThis.fetch = async () => {
      fetches += 1;
      return new Response(JSON.stringify(sampleRawWithSpend(1000 + fetches)), { status: 200 });
    };
    const t0 = new Date("2026-08-19T12:00:00.000Z");

    const first = await getCursorPeriodUsage({
      accessToken: "t",
      db,
      fetch,
      now: t0,
      cacheTtlMs: 60_000,
    });
    assert.equal(first.source, "network");
    assert.equal(first.usage.planUsage.totalSpendCents, 1001);
    assert.equal(fetches, 1);

    const second = await getCursorPeriodUsage({
      accessToken: "t",
      db,
      fetch,
      now: new Date(t0.getTime() + 30_000),
      cacheTtlMs: 60_000,
    });
    assert.equal(second.source, "cache");
    assert.equal(second.stale, false);
    assert.equal(second.usage.planUsage.totalSpendCents, 1001);
    assert.equal(fetches, 1);
    assert.equal(second.ageMs, 30_000);
  });
});

test("TTL expiry triggers a refetch", async () => {
  await withTempDb(async (db) => {
    let fetches = 0;
    const fetch: typeof globalThis.fetch = async () => {
      fetches += 1;
      return new Response(JSON.stringify(sampleRawWithSpend(2000 + fetches)), { status: 200 });
    };
    const t0 = new Date("2026-08-19T12:00:00.000Z");

    await getCursorPeriodUsage({
      accessToken: "t",
      db,
      fetch,
      now: t0,
      cacheTtlMs: 60_000,
    });
    const refreshed = await getCursorPeriodUsage({
      accessToken: "t",
      db,
      fetch,
      now: new Date(t0.getTime() + 60_000),
      cacheTtlMs: 60_000,
    });
    assert.equal(fetches, 2);
    assert.equal(refreshed.source, "network");
    assert.equal(refreshed.usage.planUsage.totalSpendCents, 2002);
    assert.equal(refreshed.stale, false);
  });
});

test("failed refresh falls back to stale cached snapshot", async () => {
  await withTempDb(async (db) => {
    const t0 = new Date("2026-08-19T12:00:00.000Z");
    writeCachedPeriodUsage(db, normalizePeriodUsage(sampleRawWithSpend(3333)), t0);

    const result = await getCursorPeriodUsage({
      accessToken: "t",
      db,
      now: new Date(t0.getTime() + 120_000),
      cacheTtlMs: 60_000,
      fetch: async () => new Response("down", { status: 503 }),
    });

    assert.equal(result.source, "stale-cache");
    assert.equal(result.stale, true);
    assert.equal(result.usage.planUsage.totalSpendCents, 3333);
    assert.equal(result.ageMs, 120_000);
    assert.match(String(result.refreshError), /503/);
  });
});

test("forceRefresh bypasses a fresh cache hit", async () => {
  await withTempDb(async (db) => {
    let fetches = 0;
    const fetch: typeof globalThis.fetch = async () => {
      fetches += 1;
      return new Response(JSON.stringify(sampleRawWithSpend(4000 + fetches)), { status: 200 });
    };
    const t0 = new Date("2026-08-19T12:00:00.000Z");
    await getCursorPeriodUsage({ accessToken: "t", db, fetch, now: t0, cacheTtlMs: 60_000 });
    const forced = await getCursorPeriodUsage({
      accessToken: "t",
      db,
      fetch,
      now: new Date(t0.getTime() + 1_000),
      cacheTtlMs: 60_000,
      forceRefresh: true,
    });
    assert.equal(fetches, 2);
    assert.equal(forced.source, "network");
    assert.equal(forced.usage.planUsage.totalSpendCents, 4002);
  });
});

test("no cache and failed refresh throws CursorUsageUnavailableError", async () => {
  await withTempDb(async (db) => {
    await assert.rejects(
      () =>
        getCursorPeriodUsage({
          accessToken: "t",
          db,
          fetch: async () => new Response("down", { status: 503 }),
        }),
      CursorUsageUnavailableError,
    );
  });
});

test("tokenExpiry reads the exp claim without verifying the signature", () => {
  // Hand-built JWT: header.payload.signature, signature deliberately garbage.
  const payload = Buffer.from(JSON.stringify({ exp: 1_800_000_000 })).toString("base64url");
  const expiry = tokenExpiry(`h.${payload}.not-a-real-signature`);
  assert.equal(expiry?.toISOString(), new Date(1_800_000_000_000).toISOString());
});

test("tokenExpiry returns null for shapes it cannot read", () => {
  assert.equal(tokenExpiry(""), null);
  assert.equal(tokenExpiry("opaque-not-a-jwt"), null);
  // Well-formed JWT with no exp claim.
  assert.equal(tokenExpiry(`h.${Buffer.from('{"sub":"x"}').toString("base64url")}.s`), null);
  // Undecodable payload must not throw.
  assert.equal(tokenExpiry("h.!!!not-base64!!!.s"), null);
});
