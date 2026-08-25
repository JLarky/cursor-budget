import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { exceptCommand } from "./except.js";
import { tempHome } from "../test-home.js";

test("except add, list, and remove a session id", () => {
  const home = tempHome("llm-budget-");
  try {
    const added = exceptCommand(["add", "21623392-2ebe-4a2a-b906-e012529de912"], home);
    assert.match(added, /Excepted 21623392/);
    assert.match(exceptCommand(["list"], home), /21623392-2ebe-4a2a-b906-e012529de912/);
    const removed = exceptCommand(["remove", "21623392-2ebe-4a2a-b906-e012529de912"], home);
    assert.match(removed, /Removed exception/);
    assert.match(exceptCommand(["list"], home), /No session exceptions/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
