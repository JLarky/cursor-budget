import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CODEX_PARSER_VERSION,
  type CodexRateLimitInfo,
  parseCodexRateLimits,
  parseCodexUsage,
  updateCodexContext,
} from "./codex.js";
import { CLAUDE_PARSER_VERSION, parseClaudeUsage, updateClaudeContext } from "./claude.js";
import type { ParserContext } from "./types.js";
import {
  getCheckpoint,
  openLlmDb,
  setCheckpoint,
  setState,
  upsertTokenEvent,
  type DatabaseSync,
} from "../db.js";
import { claudeTranscriptRoots, codexTranscriptRoots } from "../paths.js";

export type AgentKind = "claude" | "codex";

export interface ScanStats {
  totalFiles: number;
  scannedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  /** Paths of files that could not be read/parsed (capped, oldest last). */
  failedFileNames?: string[];
  malformedLines: number;
  addedEvents: number;
  updatedEvents: number;
  /**
   * Transcript roots that exist but could not be read (permissions, I/O).
   * A missing root is a normal fresh install; an unreadable one means we
   * cannot see usage that may be there, so callers must treat it as unknown.
   */
  unreadableRoots?: string[];
}

export interface ParsedFile {
  rows: Parameters<typeof upsertTokenEvent>[1][];
  malformedLines: number;
  /** Latest OpenAI-reported weekly limit telemetry (Codex only). */
  rateLimits: CodexRateLimitInfo | null;
}

export interface CollectOptions {
  home?: string;
  db?: DatabaseSync;
  /** Override discovery (tests); defaults to the agent's real transcript roots. */
  roots?: string[];
}

function sha256Hex(parts: Array<string | null | undefined>): string {
  return createHash("sha256").update(parts.map((p) => p ?? "-").join("\u0000")).digest("hex");
}

export function pathHash(path: string): string {
  return sha256Hex([path]);
}

function listJsonlFiles(roots: string[]): { files: string[]; unreadableRoots: string[] } {
  const files: string[] = [];
  const unreadableRoots: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root, { recursive: true }) as string[];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      // A missing root just means the tool has never run here.
      if (code !== "ENOENT") {
        const detail = error instanceof Error ? error.message : String(error);
        unreadableRoots.push(`${root}: ${detail}`);
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      files.push(join(root, entry));
    }
  }
  return { files: [...new Set(files)].sort(), unreadableRoots };
}

/**
 * Scan an agent's transcript JSONL files into `token_events`.
 *
 * Per-file checkpoints (size+mtime+parser version) skip unchanged files so a
 * scan between every prompt stays cheap. Parsing a file twice is safe anyway:
 * events are keyed and the fuller counters win.
 *
 * Throws only when the local store itself fails; unreadable transcript files
 * are counted in `failedFiles` instead so one bad file cannot blind the guard
 * entirely.
 */
export function collectAgentUsage(agent: AgentKind, options: CollectOptions = {}): ScanStats {
  const db = options.db ?? openLlmDb(options.home);
  const roots =
    options.roots ??
    (agent === "claude"
      ? claudeTranscriptRoots(options.home)
      : codexTranscriptRoots(options.home));
  const parserVersion = agent === "claude" ? CLAUDE_PARSER_VERSION : CODEX_PARSER_VERSION;

  const stats: ScanStats = {
    totalFiles: 0,
    scannedFiles: 0,
    skippedFiles: 0,
    failedFiles: 0,
    malformedLines: 0,
    addedEvents: 0,
    updatedEvents: 0,
  };

  const { files, unreadableRoots } = listJsonlFiles(roots);
  stats.totalFiles = files.length;
  if (unreadableRoots.length > 0) stats.unreadableRoots = unreadableRoots;

  const recordFailure = (file: string) => {
    stats.failedFiles += 1;
    stats.failedFileNames ??= [];
    if (stats.failedFileNames.length < 5) stats.failedFileNames.push(file);
  };

  for (const file of files) {
    let beforeStat: { size: number; mtimeMs: number };
    try {
      const st = statSync(file);
      beforeStat = { size: Number(st.size), mtimeMs: Number(st.mtimeMs) };
    } catch {
      recordFailure(file);
      continue;
    }

    const hash = pathHash(file);
    const checkpoint = getCheckpoint(db, hash);
    if (
      checkpoint &&
      checkpoint.size === beforeStat.size &&
      checkpoint.mtimeMs === beforeStat.mtimeMs &&
      checkpoint.parserVersion === parserVersion
    ) {
      stats.skippedFiles += 1;
      continue;
    }

    try {
      const parsed = parseTranscriptFile(agent, file, beforeStat.mtimeMs);
      for (const row of parsed.rows) {
        const outcome = upsertTokenEvent(db, row);
        if (outcome === "inserted") stats.addedEvents += 1;
        else if (outcome === "updated") stats.updatedEvents += 1;
      }
      stats.malformedLines += parsed.malformedLines;
      stats.scannedFiles += 1;
      if (parsed.rateLimits) {
        // Informational only (status display); never part of the gate math.
        setState(
          db,
          agent === "codex" ? "codex_openai_rate_limits" : `${agent}_openai_rate_limits`,
          JSON.stringify(parsed.rateLimits),
        );
      }
    } catch {
      recordFailure(file);
      continue;
    }

    // Only checkpoint when the file didn't change underneath us.
    try {
      const after = statSync(file);
      if (Number(after.size) === beforeStat.size && Number(after.mtimeMs) === beforeStat.mtimeMs) {
        setCheckpoint(db, hash, {
          path: file,
          size: beforeStat.size,
          mtimeMs: beforeStat.mtimeMs,
          parserVersion,
        });
      }
    } catch {
      // File vanished mid-scan; events are already stored. Skip checkpoint.
    }
  }

  return stats;
}

export function parseTranscriptFile(
  agent: AgentKind,
  file: string,
  fallbackMtimeMs: number,
): ParsedFile {
  const content = readFileSync(file, "utf8");
  const identity = pathHash(file);
  let context: ParserContext = { project: null, model: null, session: null };
  const rows: ParsedFile["rows"] = [];
  let malformedLines = 0;
  let rateLimits: CodexRateLimitInfo | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (typeof record !== "object" || record === null) {
      malformedLines += 1;
      continue;
    }
    const jsonRecord = record as Record<string, unknown>;

    context =
      agent === "claude"
        ? updateClaudeContext(jsonRecord, context)
        : updateCodexContext(jsonRecord, context);

    const usage =
      agent === "claude"
        ? parseClaudeUsage(jsonRecord, context)
        : parseCodexUsage(jsonRecord, context);

    if (agent === "codex") {
      const limits = parseCodexRateLimits(jsonRecord);
      if (limits) rateLimits = limits;
    }

    if (!usage) continue;

    const sessionIdentity = usage.session ?? identity;
    const messageIdentity =
      usage.message ??
      sha256Hex([
        usage.timestamp ?? String(fallbackMtimeMs),
        usage.model,
        JSON.stringify(usage.counters),
      ]);
    const eventKey = sha256Hex([agent, sessionIdentity, messageIdentity]);

    const timestampMs = parseTimestamp(usage.timestamp) ?? fallbackMtimeMs;

    rows.push({
      event_key: eventKey,
      agent,
      session_id: usage.session ?? undefined,
      model: usage.model ?? undefined,
      project: usage.project ?? undefined,
      ts: new Date(timestampMs).toISOString(),
      input_tokens: usage.counters.inputTokens,
      output_tokens: usage.counters.outputTokens,
      reasoning_tokens: usage.counters.reasoningTokens,
      cache_read_tokens: usage.counters.cacheReadTokens,
      cache_write_tokens: usage.counters.cacheWriteTokens,
      total_tokens:
        usage.counters.inputTokens +
        usage.counters.outputTokens +
        usage.counters.reasoningTokens +
        usage.counters.cacheReadTokens +
        usage.counters.cacheWriteTokens,
    });
  }

  return { rows, malformedLines, rateLimits };
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
