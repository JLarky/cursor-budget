import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { JsonValue } from "../../json-value.js";
import { fetchCopilotUsage } from "./copilot.js";
import { tempHome } from "../../test-home.js";

function jsonResponse(status: number, body: JsonValue): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function homeWithAuthDb(): Promise<string> {
  const home = tempHome("llm-budget-copilot-db-");
  const dir = join(home, ".config", "github-copilot");
  mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dir, "auth.db"));
  db.exec(`CREATE TABLE oauth_tokens (
    token_id INTEGER PRIMARY KEY AUTOINCREMENT,
    auth_authority TEXT NOT NULL,
    oauth_client_id TEXT NOT NULL,
    user_login TEXT NOT NULL,
    scopes TEXT NOT NULL,
    token_ciphertext BLOB NOT NULL,
    token_schema_version INTEGER NOT NULL,
    source_editor_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  )`);
  db.prepare(
    `INSERT INTO oauth_tokens
      (auth_authority, oauth_client_id, user_login, scopes, token_ciphertext, token_schema_version, source_editor_id, created_at, updated_at, last_used_at)
     VALUES ('github.com', 'client', 'octocat', 'repo', ?, 0, 'vim', 1, 1, 1)`,
  ).run(Buffer.from("ghu_dbtoken"));
  db.close();
  return home;
}

function homeWithHostsJson(): string {
  const home = tempHome("llm-budget-copilot-json-");
  const dir = join(home, ".config", "github-copilot");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "hosts.json"),
    JSON.stringify({ "github.com": { user: "octocat", oauth_token: "ghu_jsontoken" } }),
  );
  return home;
}

test("fetchCopilotUsage reads the auth.db token and maps quota windows", async () => {
  const home = await homeWithAuthDb();
  const usage = await fetchCopilotUsage({
    home,
    fetch: async (url, init) => {
      assert.match(String(url), /copilot_internal\/user/);
      assert.equal(new Headers(init?.headers).get("Authorization"), "token ghu_dbtoken");
      return jsonResponse(200, {
        copilot_plan: "individual",
        quota_reset_date_utc: "2026-10-01T00:00:00.000Z",
        quota_snapshots: {
          chat: { percent_remaining: 98.3, unlimited: false },
          completions: { percent_remaining: 96.8, unlimited: false },
          premium_interactions: { percent_remaining: 0, unlimited: false },
        },
      });
    },
  });
  assert.equal(usage.status, "available");
  assert.equal(usage.planLabel, "Individual");
  assert.equal(usage.windows.length, 3);
  assert.equal(usage.windows[0]?.id, "chat");
  assert.ok(Math.abs((usage.windows[0]?.usedPct ?? 0) - 1.7) < 0.001);
  assert.equal(usage.windows[0]?.resetsAt, "2026-10-01T00:00:00.000Z");
  assert.equal(usage.windows[2]?.id, "premium_interactions");
  assert.equal(usage.windows[2]?.usedPct, 100);
});

test("fetchCopilotUsage falls back to legacy hosts.json", async () => {
  const home = homeWithHostsJson();
  const usage = await fetchCopilotUsage({
    home,
    fetch: async (url, init) => {
      assert.equal(new Headers(init?.headers).get("Authorization"), "token ghu_jsontoken");
      return jsonResponse(200, {
        copilot_plan: "business",
        quota_snapshots: {
          chat: { percent_remaining: 50, unlimited: false },
        },
      });
    },
  });
  assert.equal(usage.status, "available");
  assert.equal(usage.windows[0]?.usedPct, 50);
});

test("fetchCopilotUsage skips unlimited quotas", async () => {
  const home = await homeWithAuthDb();
  const usage = await fetchCopilotUsage({
    home,
    fetch: async () =>
      jsonResponse(200, {
        copilot_plan: "business",
        quota_snapshots: {
          chat: { percent_remaining: 100, unlimited: true },
          completions: { percent_remaining: 100, unlimited: true },
        },
      }),
  });
  assert.equal(usage.status, "available");
  assert.equal(usage.windows.length, 0);
});

test("fetchCopilotUsage is unavailable with no local auth", async () => {
  const home = tempHome("llm-budget-copilot-none-");
  const usage = await fetchCopilotUsage({
    home,
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });
  assert.equal(usage.status, "unavailable");
  assert.match(usage.error ?? "", /not signed in/);
});

test("fetchCopilotUsage treats 401 as expired auth", async () => {
  const home = await homeWithAuthDb();
  const usage = await fetchCopilotUsage({
    home,
    fetch: async () => jsonResponse(401, {}),
  });
  assert.equal(usage.status, "unavailable");
  assert.match(usage.error ?? "", /expired/);
});
