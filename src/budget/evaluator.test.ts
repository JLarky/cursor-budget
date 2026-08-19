import assert from "node:assert/strict";
import test from "node:test";
import type { Usage } from "../accounting/types.js";
import { DEFAULT_CONFIG } from "../config.js";
import { evaluate, formatBlockMessage, formatUsd } from "./evaluator.js";

const estimated = (tokens: number, usd: number): Usage => ({
  totalTokens: tokens,
  usd,
  precision: "estimated",
});

test("unset limits never block", () => {
  const decision = evaluate({
    hour: estimated(9_000_000, 99),
    day: estimated(9_000_000, 99),
    config: DEFAULT_CONFIG,
    overrideUntil: null,
  });
  assert.equal(decision.allow, true);
  assert.equal(decision.reasons.length, 0);
});

test("OR semantics: hourly usd or daily tokens", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.limits.rollingHour.usd = 1;
  config.limits.calendarDay.tokens = 1000;

  const byUsd = evaluate({
    hour: estimated(10, 1.5),
    day: estimated(10, 0),
    config,
    overrideUntil: null,
  });
  assert.equal(byUsd.allow, false);
  assert.equal(byUsd.reasons[0]?.metric, "usd");

  const byTokens = evaluate({
    hour: estimated(10, 0.1),
    day: estimated(1000, 0.1),
    config,
    overrideUntil: null,
  });
  assert.equal(byTokens.allow, false);
  assert.equal(byTokens.reasons.some((r) => r.metric === "tokens"), true);
});

test("override allows without clearing usage", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.limits.rollingHour.usd = 1;
  const until = new Date(Date.now() + 60_000);
  const decision = evaluate({
    hour: estimated(10, 5),
    day: estimated(10, 5),
    config,
    overrideUntil: until,
  });
  assert.equal(decision.allow, true);
  assert.equal(decision.overrideActive, true);
});

test("excluded conversation is never blocked", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.limits.rollingHour.usd = 1;
  const decision = evaluate({
    hour: estimated(10, 5),
    day: estimated(10, 5),
    config,
    overrideUntil: null,
    excluded: true,
  });
  assert.equal(decision.allow, true);
  assert.equal(decision.excluded, true);
});

test("unknown model can block", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.unknownModel = "block";
  const decision = evaluate({
    hour: estimated(0, 0),
    day: estimated(0, 0),
    config,
    overrideUntil: null,
    unknownModel: true,
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.unknownModelBlocked, true);
});

test("block message includes session id", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.limits.rollingHour.usd = 1;
  const decision = evaluate({
    hour: estimated(10, 2),
    day: estimated(10, 2),
    config,
    overrideUntil: null,
  });
  const message = formatBlockMessage(decision, estimated(10, 2), estimated(10, 2), config, "21623392-2ebe-4a2a-b906-e012529de912");
  assert.match(message, /Session id: 21623392-2ebe-4a2a-b906-e012529de912/);
  assert.match(message, /cursor-budget except add 21623392-2ebe-4a2a-b906-e012529de912/);
});

test("formatUsd handles non-finite and sub-cent values", () => {
  assert.equal(formatUsd(Number.NaN), "$?—");
  assert.equal(formatUsd(0.006), "$0.006");
  assert.equal(formatUsd(1.5), "$1.50");
});

test("formatBlockMessage does not throw on non-finite usage", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.limits.rollingHour.usd = 1;
  const decision = evaluate({
    hour: estimated(10, Number.NaN),
    day: estimated(10, Number.NaN),
    config,
    overrideUntil: null,
  });
  // Force a reason with non-finite numbers as if a bad config slipped through.
  decision.allow = false;
  decision.reasons = [
    {
      window: "rollingHour",
      windowLabel: "Last 60 minutes",
      metric: "usd",
      used: Number.NaN as unknown as number,
      limit: "5" as unknown as number,
    },
  ];
  const message = formatBlockMessage(decision, estimated(10, Number.NaN), estimated(10, 0), config, "abc");
  assert.match(message, /Session id: abc/);
  assert.match(message, /\$\?—/);
});
