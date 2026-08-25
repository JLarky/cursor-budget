import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { asRecord, fetchJson, finiteNumber, type FetchFn } from "./http.js";
import { errored, unavailable, type ProviderUsage, type UsageWindow } from "./types.js";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

export interface CodexFetchOptions {
  home?: string;
  codexHome?: string;
  fetch?: FetchFn;
  timeoutMs?: number;
}

interface CodexTokens {
  access_token: string;
  refresh_token?: string;
  account_id?: string;
}

interface CodexAuthRecord {
  path: string;
  raw: Record<string, unknown>;
  tokens: CodexTokens;
}

function authCandidates(options: CodexFetchOptions): string[] {
  const home = options.home ?? homedir();
  const codexHome =
    options.codexHome || process.env.CODEX_HOME || join(home, ".codex");
  const paths = [
    join(codexHome, "auth.json"),
    join(home, ".config", "codex", "auth.json"),
  ];
  if (process.env.CODEX_HOME) {
    paths.unshift(join(process.env.CODEX_HOME, "auth.json"));
  }
  return paths;
}

function readAuth(options: CodexFetchOptions): CodexAuthRecord | null {
  for (const path of authCandidates(options)) {
    if (!existsSync(path)) continue;
    try {
      const raw = asRecord(JSON.parse(readFileSync(path, "utf8")));
      const tokens = asRecord(raw?.tokens);
      const access = typeof tokens?.access_token === "string" ? tokens.access_token : "";
      if (!raw || !tokens || !access) continue;
      return {
        path,
        raw,
        tokens: {
          access_token: access,
          refresh_token: typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined,
          account_id: typeof tokens.account_id === "string" ? tokens.account_id : undefined,
        },
      };
    } catch {
      continue;
    }
  }
  return null;
}

function unixToIso(value: unknown): string | null {
  const n = finiteNumber(value);
  if (n == null) return null;
  const ms = n < 10_000_000_000 ? n * 1000 : n;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function rateWindow(id: string, label: string, raw: unknown): UsageWindow | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  return {
    id,
    label,
    usedPct: finiteNumber(rec.used_percent),
    resetsAt: unixToIso(rec.reset_at),
  };
}

function windowsFromUsage(json: unknown): { windows: UsageWindow[]; planLabel: string | null } {
  const rec = asRecord(json);
  const rate = asRecord(rec?.rate_limit);
  const review = asRecord(rec?.code_review_rate_limit);
  const windows: UsageWindow[] = [];
  const session = rateWindow("session", "Session", rate?.primary_window);
  const weekly = rateWindow("weekly", "Weekly", rate?.secondary_window);
  const codeReview = rateWindow("code_review", "Code review", review?.primary_window);
  if (session) windows.push(session);
  if (weekly) windows.push(weekly);
  if (codeReview) windows.push(codeReview);
  return {
    windows,
    planLabel: typeof rec?.plan_type === "string" ? rec.plan_type : null,
  };
}

async function callUsage(
  tokens: CodexTokens,
  options: CodexFetchOptions,
): Promise<{ kind: "ok"; json: unknown } | { kind: "auth" } | { kind: "error"; detail: string }> {
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    };
    if (tokens.account_id) headers["ChatGPT-Account-Id"] = tokens.account_id;
    const res = await fetchJson(USAGE_URL, { headers }, options);
    if (res.status === 401 || res.status === 403 || res.text.trim().startsWith("<")) {
      return { kind: "auth" };
    }
    if (res.status < 200 || res.status >= 300) {
      return { kind: "error", detail: `Codex usage API HTTP ${res.status}` };
    }
    if (res.json == null) return { kind: "error", detail: "Codex usage API returned non-JSON" };
    return { kind: "ok", json: res.json };
  } catch (error) {
    return {
      kind: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function refreshToken(
  refreshToken: string,
  options: CodexFetchOptions,
): Promise<{ access_token: string; refresh_token?: string } | null> {
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CODEX_CLIENT_ID,
      refresh_token: refreshToken,
    });
    const res = await fetchJson(
      TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
      options,
    );
    const rec = asRecord(res.json);
    const access = typeof rec?.access_token === "string" ? rec.access_token : "";
    if (!res.status || res.status >= 300 || !access) return null;
    return {
      access_token: access,
      refresh_token: typeof rec?.refresh_token === "string" ? rec.refresh_token : undefined,
    };
  } catch {
    return null;
  }
}

function saveAuth(record: CodexAuthRecord, tokens: CodexTokens): void {
  try {
    const next = {
      ...record.raw,
      tokens: { ...asRecord(record.raw.tokens), ...tokens },
    };
    writeFileSync(record.path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Non-fatal; the next call can refresh again.
  }
}

/**
 * Read Codex CLI auth and ask ChatGPT for session / weekly rate-limit percents.
 */
export async function fetchCodexUsage(options: CodexFetchOptions = {}): Promise<ProviderUsage> {
  const auth = readAuth(options);
  if (!auth) {
    return unavailable("codex", "Codex", "Codex is not signed in");
  }

  let tokens = auth.tokens;
  let result = await callUsage(tokens, options);

  if (result.kind === "auth" && tokens.refresh_token) {
    const refreshed = await refreshToken(tokens.refresh_token, options);
    if (refreshed) {
      tokens = {
        ...tokens,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token ?? tokens.refresh_token,
      };
      saveAuth(auth, tokens);
      result = await callUsage(tokens, options);
    }
  }

  if (result.kind === "auth") {
    return unavailable("codex", "Codex", "Codex OAuth token expired");
  }
  if (result.kind === "error") {
    return errored("codex", "Codex", result.detail);
  }

  const parsed = windowsFromUsage(result.json);
  if (parsed.windows.length === 0) {
    return errored("codex", "Codex", "Codex usage API returned no windows");
  }
  return {
    providerId: "codex",
    displayName: "Codex",
    status: "available",
    planLabel: parsed.planLabel,
    windows: parsed.windows,
    error: null,
  };
}
