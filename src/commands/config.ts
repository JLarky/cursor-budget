import { formatSharedConfigFile } from "../unified-config.js";

export function configCommand(): string {
  return formatSharedConfigFile();
}
