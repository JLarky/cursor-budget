import assert from "node:assert/strict";
import test from "node:test";
import {
  asJsonArray,
  asJsonObject,
  jsonBoolean,
  jsonFiniteNumber,
  jsonString,
  parseJsonText,
} from "./json-value.js";

test("parseJsonText returns objects, arrays, and primitives from JSON.parse", () => {
  assert.deepEqual(parseJsonText('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonText("[1,2]"), [1, 2]);
  assert.equal(parseJsonText("null"), null);
  assert.equal(parseJsonText('"x"'), "x");
  assert.equal(parseJsonText("3"), 3);
  assert.equal(parseJsonText("true"), true);
});

test("parseJsonText throws on invalid JSON", () => {
  assert.throws(() => parseJsonText("{"), SyntaxError);
});

test("asJsonObject accepts objects and rejects arrays and primitives", () => {
  assert.deepEqual(asJsonObject({ a: 1 }), { a: 1 });
  assert.equal(asJsonObject([1]), null);
  assert.equal(asJsonObject("x"), null);
  assert.equal(asJsonObject(1), null);
  assert.equal(asJsonObject(true), null);
  assert.equal(asJsonObject(null), null);
});

test("asJsonArray accepts arrays and rejects objects", () => {
  assert.deepEqual(asJsonArray([1, "x"]), [1, "x"]);
  assert.equal(asJsonArray({ a: 1 }), null);
  assert.equal(asJsonArray(null), null);
});

test("json primitives", () => {
  assert.equal(jsonString("ok"), "ok");
  assert.equal(jsonString(1), null);
  assert.equal(jsonFiniteNumber(1.5), 1.5);
  assert.equal(jsonFiniteNumber("2"), 2);
  assert.equal(jsonFiniteNumber("  "), null);
  assert.equal(jsonBoolean(false), false);
  assert.equal(jsonBoolean("false"), null);
});
