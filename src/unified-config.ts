import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ConfigError,
  DEFAULT_CONFIG as cursorDefault,
  parseConfig,
  type Config,
} from "./config.js";
import { renderUnifiedConfigFile } from "./config-render.js";
import type { JsonValue } from "./json-value.js";
import { parseJsonc } from "./jsonc.js";
import {
  DEFAULT_CONFIG as llmDefault,
  LlmConfigError,
  parseLlmConfig,
  type LlmConfig,
} from "./llm/config.js";
import { configPath } from "./paths.js";

interface LoadedRaw {
  path: string;
  raw: JsonValue;
}

export interface ConfigReadResult {
  config: Config;
  warning?: string;
}

export interface LlmConfigReadResult {
  config: LlmConfig;
  warning: string | null;
}

function withPath(path: string, detail: string): ConfigError {
  return new ConfigError(
    `${detail}\nConfig file: ${path}\nDelete this file to regenerate defaults.`,
  );
}

function readJsoncFile(path: string): JsonValue {
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  return parseJsonc(text);
}

function loadRaw(home?: string): LoadedRaw {
  const path = configPath(home);
  if (!existsSync(path)) return { path, raw: {} };
  try {
    return { path, raw: readJsoncFile(path) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw withPath(path, `Invalid config.jsonc (not JSONC): ${detail}`);
  }
}

function persist(home: string | undefined, llm: LlmConfig, cursor: Config): void {
  const path = configPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderUnifiedConfigFile(llm, cursor));
}

function llmFromRaw(raw: JsonValue): LlmConfig {
  try {
    return parseLlmConfig(raw);
  } catch {
    return structuredClone(llmDefault);
  }
}

function cursorFromRaw(raw: JsonValue): Config {
  try {
    return parseConfig(raw);
  } catch {
    return structuredClone(cursorDefault);
  }
}

export function ensureConfig(home?: string): Config {
  const { path, raw } = loadRaw(home);
  if (!existsSync(path)) {
    persist(home, structuredClone(llmDefault), structuredClone(cursorDefault));
    return structuredClone(cursorDefault);
  }
  try {
    return parseConfig(raw);
  } catch (error) {
    if (error instanceof ConfigError) throw withPath(path, error.message);
    throw error;
  }
}

export function loadConfigForRead(home?: string): ConfigReadResult {
  try {
    return { config: ensureConfig(home) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      config: structuredClone(cursorDefault),
      warning: `Warning: using defaults because config failed to load.\n${detail}`,
    };
  }
}

export function writeConfig(config: Config, home?: string): void {
  const { raw } = loadRaw(home);
  const validated = parseConfig(config);
  const llm = withFailClosed(llmFromRaw(raw), validated.enforcement.failClosed);
  persist(home, llm, validated);
}

export function ensureLlmConfig(home?: string): LlmConfig {
  const { path, raw } = loadRaw(home);
  if (!existsSync(path)) {
    persist(home, structuredClone(llmDefault), structuredClone(cursorDefault));
    return structuredClone(llmDefault);
  }
  try {
    return parseLlmConfig(raw);
  } catch (error) {
    if (error instanceof LlmConfigError) {
      throw new LlmConfigError(`${error.message}\nConfig file: ${path}`);
    }
    throw error;
  }
}

export function loadLlmConfigForRead(home?: string): LlmConfigReadResult {
  try {
    const path = configPath(home);
    if (!existsSync(path)) {
      return { config: structuredClone(llmDefault), warning: null };
    }
    return { config: parseLlmConfig(readJsoncFile(path)), warning: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      config: structuredClone(llmDefault),
      warning: `Warning: ${detail}\nWarning: using default percent gates until config.jsonc is fixed\n`,
    };
  }
}

export function writeLlmConfig(config: LlmConfig, home?: string): void {
  const { raw } = loadRaw(home);
  persist(home, config, cursorFromRaw(raw));
}

function withFailClosed(llm: LlmConfig, failClosed: boolean): LlmConfig {
  return { ...llm, enforcement: { failClosed } };
}

/** Path + documented file for `llm-budget config` and `llm-budget cursor config`. */
export function formatSharedConfigFile(home?: string): string {
  const { warning } = loadConfigForRead(home);
  const path = configPath(home);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const body = `${path}\n\n${text}`;
  return warning ? `${warning}\n\n${body}` : body;
}
