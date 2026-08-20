import assert from "node:assert/strict";
import test from "node:test";
import { parseDuration, rollingHour } from "./windows.js";

test("rollingHour is the last 60 minutes", () => {
  const now = new Date("2026-08-19T15:30:00.000Z");
  const window = rollingHour(now);
  assert.equal(window.id, "rollingHour");
  assert.equal(window.to.toISOString(), now.toISOString());
  assert.equal(window.from.toISOString(), "2026-08-19T14:30:00.000Z");
});

test("parseDuration supports m/h/d", () => {
  assert.equal(parseDuration("15m"), 15 * 60_000);
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.equal(parseDuration("2d"), 2 * 86_400_000);
  assert.equal(parseDuration("nope"), null);
});
