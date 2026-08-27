import * as v from "valibot";

/** JSON value produced by `JSON.parse` / JSONC. */
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];
export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;

export function parseJsonText(text: string): JsonValue {
  const value = JSON.parse(text);
  // SAFETY: JSON.parse without a reviver yields a JSON value.
  return value as JsonValue;
}

export function emptyJsonObject(): JsonObject {
  // SAFETY: a new empty object has no keys and is a valid JSON object.
  return {} as JsonObject;
}

export function asJsonObject(value: JsonValue | null | undefined): JsonObject | null {
  if (value === null || value === undefined || Array.isArray(value)) return null;
  if (v.is(v.string(), value) || v.is(v.number(), value) || v.is(v.boolean(), value)) {
    return null;
  }
  return value;
}

export function asJsonArray(value: JsonValue | null | undefined): JsonArray | null {
  if (value === null || value === undefined || !Array.isArray(value)) return null;
  return value;
}

export function jsonString(value: JsonValue | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = v.safeParse(v.string(), value);
  return parsed.success ? parsed.output : null;
}

export function jsonFiniteNumber(value: JsonValue | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const asNumber = v.safeParse(v.pipe(v.number(), v.finite()), value);
  if (asNumber.success) return asNumber.output;
  const asString = v.safeParse(v.string(), value);
  if (!asString.success || !asString.output.trim()) return null;
  const n = Number(asString.output);
  return Number.isFinite(n) ? n : null;
}

export function jsonBoolean(value: JsonValue | null | undefined): boolean | null {
  if (value === null || value === undefined) return null;
  const parsed = v.safeParse(v.boolean(), value);
  return parsed.success ? parsed.output : null;
}

export function jsonStringField(obj: JsonObject, key: string): string | null {
  return jsonString(obj[key]);
}
