import assert from "node:assert/strict";
import test from "node:test";
import { nextUtcWeekStart, rollingWindowStart, utcWeekStart } from "./windows.js";

test("utcWeekStart pins Monday 00:00 UTC", () => {
  // Wednesday 2026-08-19 midday UTC → Monday 2026-08-17.
  assert.equal(utcWeekStart(new Date("2026-08-19T15:30:00.000Z")).toISOString(), "2026-08-17T00:00:00.000Z");
  // Sunday rolls back to the Monday six days earlier.
  assert.equal(utcWeekStart(new Date("2026-08-23T23:59:59.999Z")).toISOString(), "2026-08-17T00:00:00.000Z");
  // Monday 00:00 exactly is its own week start.
  assert.equal(utcWeekStart(new Date("2026-08-24T00:00:00.000Z")).toISOString(), "2026-08-24T00:00:00.000Z");
  // Monday one second after midnight too.
  assert.equal(utcWeekStart(new Date("2026-08-24T00:00:01.000Z")).toISOString(), "2026-08-24T00:00:00.000Z");
});

test("nextUtcWeekStart is exactly seven days later", () => {
  const now = new Date("2026-08-19T15:30:00.000Z");
  assert.equal(nextUtcWeekStart(now).toISOString(), "2026-08-24T00:00:00.000Z");
});

test("rollingWindowStart subtracts the window length", () => {
  const now = new Date("2026-08-19T15:30:00.000Z");
  assert.equal(
    rollingWindowStart(now, 5 * 3_600_000).toISOString(),
    "2026-08-19T10:30:00.000Z",
  );
});
