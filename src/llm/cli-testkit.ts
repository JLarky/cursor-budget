import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the compiled CLI (`dist/llm/cli.js`) in a temp HOME. Only valid after
 * `tsc`, which `npm test` guarantees.
 */
export function runCli(args: string[], home: string): Promise<CliResult> {
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
