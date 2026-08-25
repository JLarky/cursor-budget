import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ensureConfig, parseConfig, writeConfig } from "./config.js";
import { ensureLlmConfig, parseLlmConfig, writeLlmConfig } from "./llm/config.js";
import { parseJsonc } from "./jsonc.js";
import { configPath } from "./paths.js";
import { tempHome } from "./test-home.js";

test("shared config is written under ~/.config/llm-budget", () => {
  const home = tempHome("llm-budget-xdg-");
  try {
    const llm = ensureLlmConfig(home);
    llm.claudeCode.weeklyBlockAtPercent = 24;
    writeLlmConfig(llm, home);
    const cursor = ensureConfig(home);
    cursor.quota.cursorModelsBlockAtPercent = 77;
    writeConfig(cursor, home);

    assert.match(configPath(home), /\.config\/llm-budget\/config\.jsonc$/);
    const shared = parseJsonc(readFileSync(configPath(home), "utf8"));
    assert.equal(parseLlmConfig(shared).claudeCode.weeklyBlockAtPercent, 24);
    assert.equal(parseConfig(shared).quota.cursorModelsBlockAtPercent, 77);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
