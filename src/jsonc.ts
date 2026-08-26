/**
 * Minimal JSONC support: `//` line comments, `/* ... *` block comments, and
 * trailing commas. String literals are scanned so a comment marker inside a
 * value never breaks parsing.
 */

import { parseJsonText, type JsonValue } from "./json-value.js";

export type { JsonArray, JsonObject, JsonValue } from "./json-value.js";

/** Strip comments; string literals are copied verbatim. */
export function stripJsoncComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === '"') break;
        else j++;
      }
      out += src.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*" + "/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Drop commas immediately before `}` or `]` (JSONC allows them). */
export function stripTrailingCommas(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === '"') break;
        else j++;
      }
      out += src.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === "}" || src[j] === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Parse JSONC text (comments and trailing commas tolerated). */
export function parseJsonc(text: string): JsonValue {
  return parseJsonText(stripTrailingCommas(stripJsoncComments(text)));
}
