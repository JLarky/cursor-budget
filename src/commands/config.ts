import { formatConfigFile } from "../config.js";

export function configCommand(): string {
  return formatConfigFile();
}
