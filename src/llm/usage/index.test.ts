import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { JsonValue } from "../../json-value.js";
import { openLlmDb } from "../db.js";
import { fetchDirectUsage, writeUsageCache } from "./index.js";
import { tempHome } from "../../test-home.js";

function jsonResponse(status: number, body: JsonValue): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function signedInHome(): string {
  const home = tempHome("llm-budget-usage-");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "c" } }),
  );
  writeFileSync(
    join(home, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: "x" } }),
  );
  return home;
}

test("fetchDirectUsage returns both providers and caches the snapshot", async () => {
  const home = signedInHome();
  let calls = 0;
  const fetch = async (url: RequestInfo | URL) => {
    calls += 1;
    if (String(url).includes("anthropic")) {
      return jsonResponse(200, {
        five_hour: { utilization: 1 },
        seven_day: { utilization: 2 },
      });
    }
    return jsonResponse(200, {
      rate_limit: { primary_window: { used_percent: 3 } },
    });
  };
  const first = await fetchDirectUsage({ home, platform: "linux", fetch });
  assert.equal(first.providers.length, 2);
  assert.equal(first.providers[0]?.providerId, "claude");
  assert.equal(first.providers[1]?.providerId, "codex");
  const networkCalls = calls;
  const second = await fetchDirectUsage({ home, platform: "linux", fetch });
  assert.equal(calls, networkCalls);
  assert.equal(second.fetchedAt, first.fetchedAt);
});

test("fetchDirectUsage forceRefresh bypasses a fresh cache", async () => {
  const home = signedInHome();
  const db = openLlmDb(home);
  writeUsageCache(db, {
    fetchedAt: new Date().toISOString(),
    providers: [],
  });
  const snapshot = await fetchDirectUsage({
    home,
    db,
    platform: "linux",
    forceRefresh: true,
    fetch: async (url) => {
      if (String(url).includes("anthropic")) {
        return jsonResponse(200, {
          five_hour: { utilization: 9 },
          seven_day: { utilization: 9 },
        });
      }
      return jsonResponse(200, {
        rate_limit: { primary_window: { used_percent: 9 } },
      });
    },
  });
  assert.equal(snapshot.providers[0]?.windows[0]?.usedPct, 9);
});
