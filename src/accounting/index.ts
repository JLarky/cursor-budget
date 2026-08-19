import type { Config } from "../config.js";
import { LocalEstimateAccountingProvider } from "./local.js";
import type { AccountingProvider } from "./types.js";

export type { AccountingProvider, CursorHookEvent, Precision, Usage } from "./types.js";

/** Future: CursorUsageApiProvider, OpenTelemetryProvider, ProviderApiProvider */
export function getProvider(config: Config): AccountingProvider {
  return new LocalEstimateAccountingProvider(config);
}
