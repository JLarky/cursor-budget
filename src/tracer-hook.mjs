#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function reply(body) {
  process.stdout.write(JSON.stringify(body));
}

function allow() {
  reply({
    continue: true,
    permission: "allow",
  });
}

function deny(message) {
  reply({
    continue: false,
    permission: "deny",
    user_message: message,
    agent_message: message,
  });
}

function loadBlockIds(dir) {
  const file = join(dir, "block-conversation-ids.txt");
  if (!existsSync(file)) return new Set();
  return new Set(
    readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
}

const ENFORCE_EVENTS = new Set([
  "beforeSubmitPrompt",
  "preToolUse",
  "beforeShellExecution",
  "beforeMCPExecution",
  "beforeReadFile",
  "subagentStart",
]);

function safeField(value) {
  if (value == null || value === "") return "-";
  return String(value).replace(/\s+/g, "_");
}

try {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }

  const eventName = safeField(payload.hook_event_name);
  const conversationId = safeField(payload.conversation_id);
  const generationId = safeField(payload.generation_id);
  const timestamp = new Date().toISOString();

  const dir = join(homedir(), ".cursor", "llm-budget");
  const sessionFile = join(dir, "session-ids.txt");
  const eventFile = join(dir, "hook-events.txt");
  mkdirSync(dir, { recursive: true });

  let extra = "";
  if (eventName === "afterAgentThought") {
    const text = typeof payload.text === "string" ? payload.text : "";
    const chars = text.length;
    const approxTokens = Math.ceil(chars / 4);
    const durationMs = payload.duration_ms ?? "-";
    extra = ` chars=${chars} approxTokens=${approxTokens} durationMs=${durationMs}`;
    appendFileSync(
      join(dir, "thoughts.jsonl"),
      `${JSON.stringify({
        timestamp,
        conversationId,
        generationId,
        chars,
        approxTokens,
        durationMs,
        precision: "observable",
      })}\n`,
    );
  }

  appendFileSync(
    eventFile,
    `${timestamp} ${eventName} ${conversationId} ${generationId}${extra}\n`,
  );

  const existing = existsSync(sessionFile) ? readFileSync(sessionFile, "utf8") : "";
  const alreadySeen = existing.split("\n").some((line) => {
    const parts = line.trim().split(/\s+/);
    return conversationId !== "-" && parts[1] === conversationId;
  });
  if (!alreadySeen) {
    appendFileSync(sessionFile, `${timestamp} ${conversationId} ${generationId}\n`);
  }

  const blockIds = loadBlockIds(dir);
  const shouldBlock =
    blockIds.has(conversationId) && ENFORCE_EVENTS.has(eventName);

  if (shouldBlock) {
    const message =
      "cursor-budget tracer blocked this test session. Remove its id from block-conversation-ids.txt to continue.";
    appendFileSync(
      eventFile,
      `${timestamp} BLOCKED ${eventName} ${conversationId}\n`,
    );
    deny(message);
  } else {
    allow();
  }
} catch {
  allow();
}
