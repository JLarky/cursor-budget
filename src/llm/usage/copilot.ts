import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { asJsonObject, jsonString, parseJsonText, type JsonValue } from "../../json-value.js";
import { asRecord, fetchJson, finiteNumber, type FetchFn } from "./http.js";
import { errored, unavailable, type ProviderUsage, type UsageWindow } from "./types.js";

const USER_URL = "https://api.github.com/copilot_internal/user";
const EDITOR_VERSION = "Vim/9.0.0";
const USER_AGENT = "GithubCopilot/1.0.0";

export interface CopilotFetchOptions {
  home?: string;
  copilotHome?: string;
  fetch?: FetchFn;
  timeoutMs?: number;
}

interface CopilotAuth {
  oauthToken: string;
}

interface CopilotUsageWindows {
  windows: UsageWindow[];
  planLabel: string | null;
}

function copilotConfigDir(options: CopilotFetchOptions): string {
  if (options.copilotHome) return options.copilotHome;
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  const base = xdgConfig || join(options.home ?? homedir(), ".config");
  return join(base, "github-copilot");
}

/** Newer `copilot` CLI / editor integrations store all tokens in one sqlite db. */
async function readAuthDb(dir: string): Promise<CopilotAuth | null> {
  const path = join(dir, "auth.db");
  if (!existsSync(path)) return null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      // SAFETY: SELECT token_ciphertext FROM oauth_tokens; the query selects exactly
      // one BLOB column, which node:sqlite returns as a Uint8Array, or no row at all.
      const row = db
        .prepare(
          "SELECT token_ciphertext FROM oauth_tokens ORDER BY last_used_at DESC LIMIT 1",
        )
        .get() as { token_ciphertext: Uint8Array } | undefined;
      if (!row) return null;
      const oauthToken = Buffer.from(row.token_ciphertext).toString("utf8").trim();
      return oauthToken ? { oauthToken } : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Legacy per-editor `hosts.json` / `apps.json` files: `{ "github.com[:client]": { oauth_token } }`. */
function readAuthJson(dir: string, fileName: string): CopilotAuth | null {
  const path = join(dir, fileName);
  if (!existsSync(path)) return null;
  try {
    const root = asJsonObject(parseJsonText(readFileSync(path, "utf8")));
    if (!root) return null;
    for (const value of Object.values(root)) {
      const entry = asJsonObject(value);
      const oauthToken = jsonString(entry?.oauth_token)?.trim();
      if (oauthToken) return { oauthToken };
    }
    return null;
  } catch {
    return null;
  }
}

async function readAuth(options: CopilotFetchOptions): Promise<CopilotAuth | null> {
  const dir = copilotConfigDir(options);
  return (
    (await readAuthDb(dir)) ??
    readAuthJson(dir, "hosts.json") ??
    readAuthJson(dir, "apps.json")
  );
}

function quotaWindow(id: string, label: string, raw: JsonValue | null | undefined): UsageWindow | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  if (rec.unlimited === true) return null;
  const percentRemaining = finiteNumber(rec.percent_remaining);
  if (percentRemaining == null) return null;
  return { id, label, usedPct: 100 - percentRemaining, resetsAt: null };
}

function windowsFromUser(json: JsonValue | null | undefined): CopilotUsageWindows {
  const rec = asRecord(json);
  const quotas = asRecord(rec?.quota_snapshots);
  const resetsAt = jsonString(rec?.quota_reset_date_utc);
  const windows: UsageWindow[] = [];
  const chat = quotaWindow("chat", "Chat", quotas?.chat);
  const completions = quotaWindow("completions", "Completions", quotas?.completions);
  const premium = quotaWindow("premium_interactions", "Premium requests", quotas?.premium_interactions);
  for (const w of [chat, completions, premium]) {
    if (w) windows.push(resetsAt ? { ...w, resetsAt } : w);
  }
  const plan = jsonString(rec?.copilot_plan);
  return {
    windows,
    planLabel: plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null,
  };
}

async function callUser(
  token: string,
  options: CopilotFetchOptions,
): Promise<{ kind: "ok"; json: JsonValue } | { kind: "auth" } | { kind: "error"; detail: string }> {
  try {
    const res = await fetchJson(
      USER_URL,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/json",
          "Editor-Version": EDITOR_VERSION,
          "User-Agent": USER_AGENT,
        },
      },
      options,
    );
    if (res.status === 401 || res.status === 403) return { kind: "auth" };
    if (res.status < 200 || res.status >= 300) {
      return { kind: "error", detail: `Copilot user API HTTP ${res.status}` };
    }
    if (res.json == null) return { kind: "error", detail: "Copilot user API returned non-JSON" };
    return { kind: "ok", json: res.json };
  } catch (error) {
    return {
      kind: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Read GitHub Copilot's local OAuth token (CLI/editor auth store) and ask
 * GitHub for per-quota utilization (chat, completions, premium requests).
 */
export async function fetchCopilotUsage(options: CopilotFetchOptions = {}): Promise<ProviderUsage> {
  const auth = await readAuth(options);
  if (!auth) {
    return unavailable("copilot", "GitHub Copilot", "GitHub Copilot is not signed in");
  }

  const result = await callUser(auth.oauthToken, options);
  if (result.kind === "auth") {
    return unavailable("copilot", "GitHub Copilot", "GitHub Copilot OAuth token expired");
  }
  if (result.kind === "error") {
    return errored("copilot", "GitHub Copilot", result.detail);
  }

  const { windows, planLabel } = windowsFromUser(result.json);
  if (windows.length === 0) {
    return {
      providerId: "copilot",
      displayName: "GitHub Copilot",
      status: "available",
      planLabel,
      windows: [],
      error: null,
    };
  }
  return {
    providerId: "copilot",
    displayName: "GitHub Copilot",
    status: "available",
    planLabel,
    windows,
    error: null,
  };
}
