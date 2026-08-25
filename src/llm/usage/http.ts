export const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function fetchJson(
  url: string,
  init: RequestInit,
  options: { fetch?: FetchFn; timeoutMs?: number } = {},
): Promise<{ status: number; text: string; json: unknown }> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const signal = init.signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
  const response = await fetchFn(url, { ...init, signal });
  const text = await response.text();
  let json: unknown = null;
  const trimmed = text.trim();
  if (trimmed && !trimmed.startsWith("<")) {
    try {
      json = JSON.parse(trimmed);
    } catch {
      json = null;
    }
  }
  return { status: response.status, text, json };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
