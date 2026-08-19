import { ensureConfig } from "../config.js";
import { configPath } from "../paths.js";

export function configCommand(): string {
  const config = ensureConfig();
  return `${configPath()}\n\n${JSON.stringify(config, null, 2)}\n`;
}
