import assert from "node:assert/strict";
import test from "node:test";
import { parseCreditsPayload } from "./weekly.js";

const NOW = new Date("2026-09-01T00:00:00.000Z");

test("creditUsagePercent present is measured, including a real zero", () => {
  const zero = parseCreditsPayload(
    { config: { creditUsagePercent: 0, currentPeriod: { end: "2026-09-08T00:00:00.000Z" } } },
    NOW,
  );
  assert.deepEqual(zero.percent, { kind: "measured", percent: 0, source: "creditUsagePercent" });
  assert.equal(zero.resetsAt, "2026-09-08T00:00:00.000Z");

  const nonzero = parseCreditsPayload(
    { config: { creditUsagePercent: 42.5, currentPeriod: { end: "2026-09-08T00:00:00.000Z" } } },
    NOW,
  );
  assert.deepEqual(nonzero.percent, { kind: "measured", percent: 42.5, source: "creditUsagePercent" });
});

test("missing creditUsagePercent with onDemandCap 0 is unmetered, never 0%", () => {
  const weekly = parseCreditsPayload(
    {
      config: {
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        currentPeriod: { start: "2026-09-01T00:00:00.000Z", end: "2026-09-08T00:00:00.000Z" },
      },
    },
    NOW,
  );
  assert.equal(weekly.percent.kind, "unmetered");
  assert.equal(weekly.resetsAt, "2026-09-08T00:00:00.000Z");
});

test("missing creditUsagePercent falls back to the on-demand ratio when cap > 0", () => {
  const weekly = parseCreditsPayload(
    {
      config: {
        onDemandCap: { val: 20 },
        onDemandUsed: { val: 5 },
        billingPeriodEnd: "2026-09-08T00:00:00.000Z",
      },
    },
    NOW,
  );
  assert.deepEqual(weekly.percent, { kind: "measured", percent: 25, source: "onDemandRatio" });
});

test("a well-formed payload with no percent and no period is unavailable, not unmetered", () => {
  const weekly = parseCreditsPayload({ config: { someOtherField: true } }, NOW);
  assert.equal(weekly.percent.kind, "unavailable");
});

test("garbage bodies are unavailable", () => {
  assert.equal(parseCreditsPayload("not an object", NOW).percent.kind, "unavailable");
  assert.equal(parseCreditsPayload(null, NOW).percent.kind, "unavailable");
  assert.equal(parseCreditsPayload({}, NOW).percent.kind, "unavailable");
  assert.equal(parseCreditsPayload([1, 2, 3], NOW).percent.kind, "unavailable");
});

test("out-of-range creditUsagePercent falls through to the next source instead of throwing", () => {
  const weekly = parseCreditsPayload(
    {
      config: {
        creditUsagePercent: 150,
        currentPeriod: { end: "2026-09-08T00:00:00.000Z" },
      },
    },
    NOW,
  );
  assert.equal(weekly.percent.kind, "unmetered");
});

test("resetsAt normalizes xAI's offset timestamp to toISOString like Claude and Codex", () => {
  const weekly = parseCreditsPayload(
    {
      config: {
        creditUsagePercent: 10,
        currentPeriod: { end: "2026-09-07T09:10:36.248069+00:00" },
      },
    },
    NOW,
  );
  assert.equal(weekly.resetsAt, "2026-09-07T09:10:36.248Z");
});

test("resetsAt is null when the vendor period end cannot be parsed as a date", () => {
  const weekly = parseCreditsPayload(
    {
      config: {
        creditUsagePercent: 10,
        currentPeriod: { end: "not-a-date" },
      },
    },
    NOW,
  );
  assert.equal(weekly.resetsAt, null);
});

test("fetchedAt always reflects the caller's clock", () => {
  const weekly = parseCreditsPayload({ config: { creditUsagePercent: 1 } }, NOW);
  assert.equal(weekly.fetchedAt, NOW.toISOString());
});
