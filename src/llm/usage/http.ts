import {
  asJsonObject,
  jsonFiniteNumber,
  parseJsonText,
  type JsonObject,
  type JsonValue,
} from "../../json-value.js";

export const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface JsonResponse {
  status: number;
  text: string;
  json: JsonValue | null;
}

export async function fetchJson(
  url: string,
  init: RequestInit,
  options: { fetch?: FetchFn; timeoutMs?: number } = {},
): Promise<JsonResponse> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const signal = init.signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
  const response = await fetchFn(url, { ...init, signal });
  const text = await response.text();
  let json: JsonValue | null = null;
  const trimmed = text.trim();
  if (trimmed && !trimmed.startsWith("<")) {
    try {
      json = parseJsonText(trimmed);
    } catch {
      json = null;
    }
  }
  return { status: response.status, text, json };
}

export function asRecord(value: JsonValue | null | undefined): JsonObject | null {
  return asJsonObject(value);
}

export function finiteNumber(value: JsonValue | null | undefined): number | null {
  return jsonFiniteNumber(value);
}
