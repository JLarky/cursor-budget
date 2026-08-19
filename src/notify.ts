import { spawn } from "node:child_process";

export function notify(title: string, body: string): void {
  if (process.platform === "darwin") {
    spawn("osascript", ["-e", `display notification ${json(body)} with title ${json(title)}`], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }
  spawn("notify-send", [title, body], { detached: true, stdio: "ignore" }).unref();
}

function json(value: string): string {
  return JSON.stringify(value);
}
