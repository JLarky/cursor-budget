import assert from "node:assert/strict";
import test from "node:test";
import { calendarDay, parseDuration, rollingHour } from "./windows.js";

test("rolling hour starts 60 minutes ago", () => {
  const now = new Date("2026-08-19T20:00:00.000Z");
  const window = rollingHour(now);
  assert.equal(window.from.toISOString(), "2026-08-19T19:00:00.000Z");
  assert.equal(window.to.toISOString(), now.toISOString());
});

test("calendar day starts at local midnight", () => {
  const now = new Date();
  now.setHours(15, 30, 0, 0);
  const window = calendarDay(now);
  assert.equal(window.from.getHours(), 0);
  assert.equal(window.from.getMinutes(), 0);
  assert.ok(window.from.getTime() <= now.getTime());
});

test("parseDuration", () => {
  assert.equal(parseDuration("15m"), 15 * 60 * 1000);
  assert.equal(parseDuration("1h"), 60 * 60 * 1000);
  assert.equal(parseDuration("off"), null);
});
