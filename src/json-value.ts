import * as v from "valibot";

/** JSON value produced by `JSON.parse` / JSONC. */
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];
export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;

export const JsonValueSchema: v.GenericSchema<JsonValue> = v.lazy(() =>
  v.union([
    v.string(),
    v.number(),
    v.boolean(),
    v.null(),
    v.array(JsonValueSchema),
    v.record(v.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema: v.GenericSchema<JsonObject> = v.record(
  v.string(),
  JsonValueSchema,
);

export function parseJsonText(text: string): JsonValue {
  return v.parse(JsonValueSchema, JSON.parse(text));
}

export function emptyJsonObject(): JsonObject {
  return v.parse(JsonObjectSchema, {});
}

export function asJsonObject(value: JsonValue | null | undefined): JsonObject | null {
  if (value === null || value === undefined || Array.isArray(value)) return null;
  const parsed = v.safeParse(JsonObjectSchema, value);
  return parsed.success ? parsed.output : null;
}

export function asJsonArray(value: JsonValue | null | undefined): JsonArray | null {
  if (value === null || value === undefined) return null;
  const parsed = v.safeParse(v.array(JsonValueSchema), value);
  return parsed.success ? parsed.output : null;
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
