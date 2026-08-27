import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { JsonValue } from "../../json-value.js";
import { fetchCodexUsage } from "./codex.js";
import { tempHome } from "../../test-home.js";

function jsonResponse(status: number, body: JsonValue): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function homeWithCodexAuth(): string {
  const home = tempHome("llm-budget-codex-");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    join(home, ".codex", "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: "codex-access",
        refresh_token: "codex-refresh",
        account_id: "acct-1",
      },
    }),
  );
  return home;
}

test("fetchCodexUsage maps session and weekly rate-limit windows", async () => {
  const home = homeWithCodexAuth();
  const usage = await fetchCodexUsage({
    home,
    fetch: async (url, init) => {
      assert.match(String(url), /wham\/usage/);
      assert.equal(new Headers(init?.headers).get("ChatGPT-Account-Id"), "acct-1");
      return jsonResponse(200, {
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 8, reset_at: 1788081853 },
          secondary_window: { used_percent: 22, reset_at: 1788686653 },
        },
      });
    },
  });
  assert.equal(usage.status, "available");
  assert.equal(usage.planLabel, "plus");
  assert.equal(usage.windows[0]?.id, "session");
  assert.equal(usage.windows[0]?.usedPct, 8);
  assert.equal(usage.windows[0]?.resetsAt, "2026-08-30T09:24:13.000Z");
  assert.equal(usage.windows[1]?.id, "weekly");
  assert.equal(usage.windows[1]?.usedPct, 22);
});

test("fetchCodexUsage is unavailable without auth.json", async () => {
  const home = tempHome("llm-budget-codex-none-");
  const usage = await fetchCodexUsage({
    home,
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });
  assert.equal(usage.status, "unavailable");
  assert.match(usage.error ?? "", /not signed in/);
});

test("fetchCodexUsage treats an HTML body as expired auth", async () => {
  const home = homeWithCodexAuth();
  const usage = await fetchCodexUsage({
    home,
    fetch: async () => new Response("<html>login</html>", { status: 200 }),
  });
  assert.equal(usage.status, "unavailable");
  assert.match(usage.error ?? "", /expired/);
});

test("fetchCodexUsage refreshes and retries after 401", async () => {
  const home = homeWithCodexAuth();
  const usage = await fetchCodexUsage({
    home,
    fetch: async (url, init) => {
      if (String(url).includes("auth.openai.com")) {
        return jsonResponse(200, { access_token: "codex-access-2", refresh_token: "codex-refresh-2" });
      }
      const auth = String(new Headers(init?.headers).get("Authorization"));
      if (auth.includes("codex-access-2")) {
        return jsonResponse(200, {
          rate_limit: { primary_window: { used_percent: 3 } },
        });
      }
      return jsonResponse(401, {});
    },
  });
  assert.equal(usage.status, "available");
  assert.equal(usage.windows[0]?.usedPct, 3);
  const saved = JSON.parse(readFileSync(join(home, ".codex", "auth.json"), "utf8"));
  assert.equal(saved.tokens.access_token, "codex-access-2");
});
