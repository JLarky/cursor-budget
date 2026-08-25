import { renderUnifiedConfigFile } from "./config-render.js";
import { ConfigFileSchema } from "./config-schema.js";
import { DEFAULT_CONFIG as LLM_DEFAULT_CONFIG } from "./llm/config.js";
import * as v from "valibot";

export interface QuotaConfig {
  /**
   * Block when dashboard "Cursor Models" meter (`autoPercentUsed`) reaches this value.
   * Scale is **0–100** (same as the API), not 0–1. Distinct from `warnings`.
   */
  cursorModelsBlockAtPercent: number;
  /**
   * Block when dashboard "Other Models" meter (`apiPercentUsed`) reaches this value.
   * Scale is **0–100** (same as the API), not 0–1.
   */
  otherModelsBlockAtPercent: number;
  /**
   * Optional block on `totalPercentUsed` (**0–100**). `null` disables.
   */
  totalBlockAtPercent: number | null;
  /** Beyond this age, a stale-cache snapshot is treated as unknown usage. */
  maxStaleMs: number;
  /** Soft TTL for the SQLite usage cache before a network refresh is attempted. */
  cacheTtlMs: number;
}

export interface RateLimitConfig {
  /**
   * Rolling-hour event-count backstop. `null` disables.
   *
   * This is a runaway-loop catch, not a budget: the quota gate above is the
   * real limit. The default sits well above observed heavy use (peak measured
   * at 129 events/h) so normal agent work never trips it, while still capping
   * a stuck loop that could otherwise burn a lot inside one cache window.
   */
  maxEventsPerHour: number | null;
}

export interface Config {
  quota: QuotaConfig;
  rateLimit: RateLimitConfig;
  /**
   * Warning fractions of each quota block threshold (**0–1** scale).
   * e.g. `0.5` with `cursorModelsBlockAtPercent: 90` warns at 45% API usage.
   */
  warnings: number[];
  enforcement: {
    /**
     * When usage cannot be determined (auth expired, API down, snapshot older
     * than `maxStaleMs`), block instead of allowing. Default `true`: a guard
     * that silently stops guarding is worse than one that gets in the way.
     * Escape hatches stay open — `override`, `except add`, and every read-only
     * CLI command keep working while the gate is closed.
     */
    failClosed: boolean;
  };
  excludeConversationIds: string[];
}

export const DEFAULT_CONFIG: Config = {
  quota: {
    cursorModelsBlockAtPercent: 90,
    otherModelsBlockAtPercent: 90,
    totalBlockAtPercent: null,
    maxStaleMs: 3_600_000,
    cacheTtlMs: 90_000,
  },
  rateLimit: {
    maxEventsPerHour: 500,
  },
  warnings: [0.5, 0.75, 0.9],
  enforcement: {
    failClosed: true,
  },
  excludeConversationIds: [],
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function parseConfig(raw: unknown): Config {
  let parsed: v.InferOutput<typeof ConfigFileSchema>;
  try {
    parsed = v.parse(ConfigFileSchema, raw);
  } catch (error) {
    if (error instanceof v.ValiError) {
      throw new ConfigError(`Invalid config.jsonc:\n${v.summarize(error.issues)}`);
    }
    throw error;
  }

  const slice = parsed.cursor;
  const quota = slice?.quota ?? parsed.quota;
  const rateLimit = slice?.rateLimit ?? parsed.rateLimit;
  const warnings = slice?.warnings ?? parsed.warnings;
  const enforcement = slice?.enforcement ?? parsed.enforcement;
  const excludeConversationIds =
    slice?.excludeConversationIds ?? parsed.excludeConversationIds;

  return {
    quota: {
      cursorModelsBlockAtPercent:
        quota?.cursorModelsBlockAtPercent ?? DEFAULT_CONFIG.quota.cursorModelsBlockAtPercent,
      otherModelsBlockAtPercent:
        quota?.otherModelsBlockAtPercent ?? DEFAULT_CONFIG.quota.otherModelsBlockAtPercent,
      totalBlockAtPercent:
        quota?.totalBlockAtPercent === undefined
          ? DEFAULT_CONFIG.quota.totalBlockAtPercent
          : quota.totalBlockAtPercent,
      maxStaleMs: quota?.maxStaleMs ?? DEFAULT_CONFIG.quota.maxStaleMs,
      cacheTtlMs: quota?.cacheTtlMs ?? DEFAULT_CONFIG.quota.cacheTtlMs,
    },
    rateLimit: {
      maxEventsPerHour:
        rateLimit?.maxEventsPerHour === undefined
          ? DEFAULT_CONFIG.rateLimit.maxEventsPerHour
          : rateLimit.maxEventsPerHour,
    },
    warnings: warnings ?? DEFAULT_CONFIG.warnings,
    enforcement: {
      failClosed: enforcement?.failClosed ?? DEFAULT_CONFIG.enforcement.failClosed,
    },
    excludeConversationIds: excludeConversationIds ?? [],
  };
}

/**
 * Render a fully-documented config.jsonc so the file doubles as schema docs.
 * Cursor Agent keys sit under `cursor`; Claude Code and Codex use defaults
 * here so a Cursor-only rewrite still leaves a valid shared file.
 */
export function renderConfigFile(c: Config): string {
  return renderUnifiedConfigFile(structuredClone(LLM_DEFAULT_CONFIG), c);
}

export { ensureConfig, loadConfigForRead, writeConfig } from "./unified-config.js";
