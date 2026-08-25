import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

/**
 * Unique fake $HOME for the current test. Removed when that test finishes
 * (including on failure), so /tmp does not accumulate llm-budget-* dirs.
 */
export function tempHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  after(() => {
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}
