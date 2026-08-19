export type Precision = "exact" | "estimated" | "observable";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  totalTokens: number;
  observableTokens?: number;
  usd?: number;
  observableUsd?: number;
  precision: Precision;
}

export interface CursorHookEvent {
  hook_event_name?: string;
  conversation_id?: string;
  generation_id?: string;
  model?: string;
  model_id?: string;
  prompt?: string;
  text?: string;
  context_tokens?: number;
  context_window_size?: number;
  context_usage_percent?: number;
  trigger?: string;
  [key: string]: unknown;
}

export interface AccountingProvider {
  getUsage(window: { from: Date; to: Date }): Promise<Usage>;
  recordEvent?(event: CursorHookEvent): Promise<void>;
  readonly precision: Precision;
}
