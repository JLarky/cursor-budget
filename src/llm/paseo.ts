import { homedir } from "node:os";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

/**
 * Percentages come from the Paseo daemon's provider-usage feed: it resolves
 * each provider's real limits (Anthropic OAuth for Claude Code, OpenAI's
 * own rate-limit telemetry for Codex) and reports utilization windows.
 * llm-budget adds no token math of its own.
 */

export interface PaseoUsageWindow {
  id: string;
  label: string;
  /** 0–100 percent of the provider's own limit already used. */
  usedPct: number | null;
  resetsAt: string | null;
}

export interface PaseoProviderUsage {
  providerId: string;
  displayName: string;
  status: "available" | "unavailable" | "error";
  planLabel: string | null;
  windows: PaseoUsageWindow[];
  error: string | null;
}

export interface PaseoUsageSnapshot {
  fetchedAt: string;
  providers: PaseoProviderUsage[];
}

export type PaseoUsageFetcher = () => PaseoUsageSnapshot | Promise<PaseoUsageSnapshot>;

const DEFAULT_URL = "ws://127.0.0.1:6767/ws";
const DEFAULT_TIMEOUT_MS = 5_000;

function daemonUrl(): string {
  return process.env.LLM_BUDGET_PASEO_URL ?? DEFAULT_URL;
}

function timeoutMs(): number {
  const raw = process.env.LLM_BUDGET_PASEO_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  const ms = timeoutMs();
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

/** Defensive normalization: the daemon's schema may evolve independently. */
export function normalizeProviderUsage(payload: unknown): PaseoUsageSnapshot {
  const root = asRecord(payload);
  const fetchedAt = typeof root?.fetchedAt === "string" ? root.fetchedAt : new Date().toISOString();
  const rawProviders = Array.isArray(root?.providers) ? root.providers : [];
  const providers: PaseoProviderUsage[] = [];
  for (const raw of rawProviders) {
    const entry = asRecord(raw);
    if (!entry || typeof entry.providerId !== "string") continue;
    const status =
      entry.status === "available" || entry.status === "error" ? entry.status : "unavailable";
    const windows: PaseoUsageWindow[] = [];
    if (Array.isArray(entry.windows)) {
      for (const rawWindow of entry.windows) {
        const window = asRecord(rawWindow);
        if (!window || typeof window.id !== "string") continue;
        windows.push({
          id: window.id,
          label: typeof window.label === "string" ? window.label : window.id,
          usedPct:
            typeof window.usedPct === "number" && Number.isFinite(window.usedPct)
              ? window.usedPct
              : null,
          resetsAt: typeof window.resetsAt === "string" ? window.resetsAt : null,
        });
      }
    }
    providers.push({
      providerId: entry.providerId,
      displayName: typeof entry.displayName === "string" ? entry.displayName : entry.providerId,
      status,
      planLabel: typeof entry.planLabel === "string" ? entry.planLabel : null,
      windows,
      error: typeof entry.error === "string" ? entry.error : null,
    });
  }
  return { fetchedAt, providers };
}

/**
 * One-shot query against the local Paseo daemon. Connects, asks for the
 * provider usage list, disconnects. Any failure (daemon down, auth, slow
 * response) throws so the guard can fail closed.
 */
export async function fetchPaseoUsage(): Promise<PaseoUsageSnapshot> {
  return withTimeout(
    (async () => {
      const client = new DaemonClient({
        url: daemonUrl(),
        clientId: "llm-budget",
        clientType: "cli",
        password: process.env.PASEO_PASSWORD,
        connectTimeoutMs: timeoutMs(),
        reconnect: { enabled: false },
        webSocketFactory: (url) =>
          new WebSocket(url) as unknown as import("@getpaseo/client/internal/daemon-client").WebSocketLike,
      });
      await client.connect();
      try {
        return normalizeProviderUsage(await client.listProviderUsage());
      } finally {
        await client.close().catch(() => {});
      }
    })(),
    "paseo provider usage",
  );
}

/** Find one provider's entry in a snapshot. */
export function providerUsage(
  snapshot: PaseoUsageSnapshot,
  providerId: string,
): PaseoProviderUsage | null {
  return snapshot.providers.find((p) => p.providerId === providerId) ?? null;
}

/** Convenience for tests and callers that want a stable empty snapshot. */
export function emptySnapshot(): PaseoUsageSnapshot {
  return { fetchedAt: new Date(0).toISOString(), providers: [] };
}

export function paseoHomeHint(home = homedir()): string {
  void home;
  return "start the Paseo daemon (paseo daemon start)";
}
