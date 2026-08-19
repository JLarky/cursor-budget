import { loadConfigForRead } from "../config.js";
import { configPath } from "../paths.js";

export function configCommand(): string {
  const { config, warning } = loadConfigForRead();
  const body = `${configPath()}\n\n${JSON.stringify(config, null, 2)}\n`;
  return warning ? `${warning}\n\n${body}` : body;
}
