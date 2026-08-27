import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".test.ts")) yield path;
  }
}

const files = [...walk(root)].sort();
if (files.length === 0) {
  console.error("No anti-slop plugin tests found.");
  process.exit(1);
}

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--import", "tsx", file], {
    stdio: "inherit",
  });
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
