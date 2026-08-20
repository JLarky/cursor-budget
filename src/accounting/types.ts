export interface CursorHookEvent {
  hook_event_name?: string;
  conversation_id?: string;
  generation_id?: string;
  model?: string;
  model_id?: string;
  prompt?: string;
  text?: string;
  [key: string]: unknown;
}

export interface AccountingProvider {
  /** Count recorded events in the window (rate-limit backstop). */
  countEvents(window: { from: Date; to: Date }): Promise<number>;
  recordEvent?(event: CursorHookEvent): Promise<void>;
}
