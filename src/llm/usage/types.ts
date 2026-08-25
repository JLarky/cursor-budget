/**
 * Provider-reported usage windows. Same shape the guard already consumes
 * from Paseo — percents are 0–100 of the provider's own limit.
 */

export interface UsageWindow {
  id: string;
  label: string;
  usedPct: number | null;
  resetsAt: string | null;
}

export interface ProviderUsage {
  providerId: string;
  displayName: string;
  status: "available" | "unavailable" | "error";
  planLabel: string | null;
  windows: UsageWindow[];
  error: string | null;
}

export interface UsageSnapshot {
  fetchedAt: string;
  providers: ProviderUsage[];
}

export type UsageFetcher = () => UsageSnapshot | Promise<UsageSnapshot>;

export function emptySnapshot(fetchedAt = new Date(0).toISOString()): UsageSnapshot {
  return { fetchedAt, providers: [] };
}

export function providerUsage(snapshot: UsageSnapshot, providerId: string): ProviderUsage | null {
  return snapshot.providers.find((p) => p.providerId === providerId) ?? null;
}

export function unavailable(
  providerId: string,
  displayName: string,
  error?: string | null,
): ProviderUsage {
  return {
    providerId,
    displayName,
    status: "unavailable",
    planLabel: null,
    windows: [],
    error: error ?? null,
  };
}

export function errored(
  providerId: string,
  displayName: string,
  error: string,
): ProviderUsage {
  return {
    providerId,
    displayName,
    status: "error",
    planLabel: null,
    windows: [],
    error,
  };
}
