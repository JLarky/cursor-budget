import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ConfigError,
  DEFAULT_CONFIG,
  ensureConfig,
  parseConfig,
  renderConfigFile,
  writeConfig,
} from "./config.js";
import { configPath } from "./paths.js";
import { parseJsonc, stripJsoncComments } from "./jsonc.js";
import { tempHome } from "./test-home.js";

test("empty object uses defaults", () => {
  const config = parseConfig({});
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test("rejects unknown top-level fields", () => {
  assert.throws(
    () => parseConfig({ limits: { rollingHour: { usd: 1 } } }),
    (error) => error instanceof ConfigError && /Invalid config\.json/.test(error.message),
  );
});

test("windows are independent — no inheritance between agents", () => {
  const config = parseConfig({
    claude: { windows: { weekly: { blockAtPercent: 24 } } },
    cursor: { windows: { cursorModels: { blockAtPercent: 77 } } },
  });
  assert.equal(config.claude.windows.weekly.blockAtPercent, 24);
  // Untouched windows keep their own defaults, not the sibling's value.
  assert.equal(config.claude.windows.five_hour.blockAtPercent, 80);
  assert.equal(config.cursor.windows.cursorModels.blockAtPercent, 77);
  assert.equal(config.cursor.windows.otherModels.blockAtPercent, 90);
});

test("null blockAtPercent means monitor-only, distinct from omitted", () => {
  const config = parseConfig({ codex: { windows: { session: { blockAtPercent: 40 } } } });
  assert.equal(config.codex.windows.session.blockAtPercent, 40);
  assert.equal(config.codex.windows.weekly.blockAtPercent, 80);

  const monitorOnly = parseConfig({});
  assert.equal(monitorOnly.codex.windows.session.blockAtPercent, null);
  assert.equal(monitorOnly.cursor.windows.total.blockAtPercent, null);
});

test("allows $schema and _comment annotations", () => {
  const config = parseConfig({
    $schema: "https://example.com/llm-budget.schema.json",
    _comment: "quota caps",
    cursor: { windows: { cursorModels: { blockAtPercent: 80 } } },
  });
  assert.equal(config.cursor.windows.cursorModels.blockAtPercent, 80);
  assert.equal(config.cursor.windows.otherModels.blockAtPercent, 90);
});

test("rejects percent thresholds outside 0–100", () => {
  assert.throws(
    () => parseConfig({ cursor: { windows: { cursorModels: { blockAtPercent: 101 } } } }),
    ConfigError,
  );
  assert.throws(
    () => parseConfig({ cursor: { windows: { otherModels: { blockAtPercent: -1 } } } }),
    ConfigError,
  );
});

test("rejects warnings outside 0–1", () => {
  assert.throws(() => parseConfig({ cursor: { warnings: [1.5] } }), ConfigError);
});

test("rejects string blockAtPercent values", () => {
  assert.throws(
    () =>
      parseConfig(
        parseJsonc('{ "cursor": { "windows": { "cursorModels": { "blockAtPercent": "90" } } } }'),
      ),
    ConfigError,
  );
});

test("rejects a string Claude threshold instead of treating it as unknown", () => {
  assert.throws(
    () =>
      parseConfig(
        parseJsonc('{ "claude": { "windows": { "weekly": { "blockAtPercent": "24" } } } }'),
      ),
    ConfigError,
  );
});

test("rejects unknown nested keys", () => {
  assert.throws(
    () =>
      parseConfig({
        cursor: { windows: { cursorModels: { blockAtPercent: 90, extra: true } } },
      }),
    ConfigError,
  );
});

test("accepts null blockAtPercent and rate limit", () => {
  const config = parseConfig({
    cursor: {
      windows: { total: { blockAtPercent: null } },
      rateLimit: { maxEventsPerHour: null },
    },
  });
  assert.equal(config.cursor.windows.total.blockAtPercent, null);
  assert.equal(config.cursor.rateLimit.maxEventsPerHour, null);
});

test("ensureConfig treats whitespace-only file as empty object", () => {
  const home = tempHome("llm-budget-ws-");
  try {
    ensureConfig(home);
    writeFileSync(configPath(home), "  \n\t\n");
    const config = ensureConfig(home);
    assert.deepEqual(config, DEFAULT_CONFIG);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensureConfig errors include config path and recovery hint", () => {
  const home = tempHome("llm-budget-err-");
  try {
    ensureConfig(home);
    const path = configPath(home);
    writeFileSync(path, "{not-json");
    assert.throws(
      () => ensureConfig(home),
      (error) =>
        error instanceof ConfigError &&
        error.message.includes(path) &&
        /Delete this file to regenerate defaults/.test(error.message),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a broken codex section fails closed for the whole file, not just codex", () => {
  const home = tempHome("llm-budget-mix-");
  try {
    mkdirSync(join(home, ".config", "llm-budget"), { recursive: true });
    writeFileSync(
      join(home, ".config", "llm-budget", "config.jsonc"),
      `{ "codex": { "windows": { "weekly": { "blockAtPercent": "bad" } } } }\n`,
    );
    assert.throws(() => ensureConfig(home), ConfigError);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeConfig writes exactly what it is given — no merge with disk", () => {
  const home = tempHome("llm-budget-write-");
  try {
    const config = ensureConfig(home);
    config.cursor.excludeConversationIds = ["sess-1"];
    writeConfig(config, home);
    const text = readFileSync(configPath(home), "utf8");
    assert.match(text, /llm-budget configuration/);
    assert.match(text, /"excludeConversationIds": \["sess-1"\]/);
    const reparsed = parseConfig(JSON.parse(stripJsoncComments(text)));
    assert.deepEqual(reparsed.cursor.excludeConversationIds, ["sess-1"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("first run writes a documented config.jsonc with every field", () => {
  const home = tempHome("llm-budget-cfg-");
  try {
    const config = ensureConfig(home);
    assert.deepEqual(config, DEFAULT_CONFIG);
    const path = configPath(home);
    const text = readFileSync(path, "utf8");
    for (const field of [
      "enabled",
      "blockAtPercent",
      "maxEventsPerHour",
      "failClosed",
      "excludeSessionIds",
      "excludeConversationIds",
    ]) {
      assert.match(text, new RegExp(`"${field}"`));
    }
    assert.deepEqual(parseConfig(parseJsonc(text)), DEFAULT_CONFIG);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensureConfig backfills a pre-grok config.jsonc with the grok section", () => {
  const home = tempHome("llm-budget-grok-backfill-");
  try {
    mkdirSync(join(home, ".config", "llm-budget"), { recursive: true });
    writeFileSync(
      join(home, ".config", "llm-budget", "config.jsonc"),
      `{
  "claude": { "windows": { "weekly": { "blockAtPercent": 42 } } },
  "codex": {},
  "cursor": {},
  "enforcement": { "failClosed": true }
}
`,
    );
    const config = ensureConfig(home);
    assert.equal(config.claude.windows.weekly.blockAtPercent, 42);

    const text = readFileSync(configPath(home), "utf8");
    assert.match(text, /"grok"/);
    assert.match(text, /grok\.windows\.weekly/);
    assert.match(text, /"weekly": \{ "blockAtPercent": 42 \}/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensureConfig leaves a config.jsonc with a grok section untouched", () => {
  const home = tempHome("llm-budget-grok-present-");
  try {
    mkdirSync(join(home, ".config", "llm-budget"), { recursive: true });
    const original = `{
  "grok": { "windows": { "weekly": { "blockAtPercent": 55 } } }
}
`;
    writeFileSync(join(home, ".config", "llm-budget", "config.jsonc"), original);
    ensureConfig(home);
    const text = readFileSync(configPath(home), "utf8");
    assert.equal(text, original);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("round-trip: rendering the documented file and parsing it back is stable", () => {
  const customized = parseConfig({
    claude: { windows: { weekly: { blockAtPercent: 50 } } },
    codex: { windows: { session: { blockAtPercent: 3 } } },
    enforcement: { failClosed: false },
    excludeSessionIds: ["sess-1"],
  });
  assert.equal(customized.claude.windows.weekly.blockAtPercent, 50);
  assert.equal(customized.codex.windows.session.blockAtPercent, 3);
  assert.equal(customized.enforcement.failClosed, false);

  const rendered = renderConfigFile(customized);
  assert.deepEqual(parseConfig(parseJsonc(rendered)), customized);
});
