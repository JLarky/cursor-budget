import { spawn, type ChildProcess } from "node:child_process";

export function notify(title: string, body: string): void {
  if (process.platform === "darwin") {
    ignoreSpawnErrors(
      spawn("osascript", ["-e", `display notification ${json(body)} with title ${json(title)}`], {
        detached: true,
        stdio: "ignore",
      }),
    );
    return;
  }
  ignoreSpawnErrors(spawn("notify-send", [title, body], { detached: true, stdio: "ignore" }));
}

function ignoreSpawnErrors(child: ChildProcess): void {
  child.on("error", () => {
    // Best-effort desktop notification; missing binaries must not crash the hook.
  });
  child.unref();
}

function json(value: string): string {
  return JSON.stringify(value);
}
