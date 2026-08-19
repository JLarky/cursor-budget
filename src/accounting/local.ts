import type { Config } from "../config.js";
import { costUsd, resolveRate } from "../pricing.js";
import { countObservableTokens } from "../tokenizer.js";
import {
  insertContextSnapshot,
  insertUsageEvent,
  makeDedupeKey,
  openDb,
  sumUsage,
  withImmediate,
  type UsageRow,
} from "../db/client.js";
import type { AccountingProvider, CursorHookEvent, Usage } from "./types.js";

export class LocalEstimateAccountingProvider implements AccountingProvider {
  readonly precision = "estimated" as const;

  constructor(private readonly config: Config) {}

  async getUsage(window: { from: Date; to: Date }): Promise<Usage> {
    const db = openDb();
    const sums = sumUsage(db, window.from, window.to, this.config.excludeConversationIds);
    return {
      inputTokens: sums.input,
      outputTokens: sums.output,
      reasoningTokens: sums.reasoning,
      totalTokens: sums.estimatedTokens,
      observableTokens: sums.input + sums.output + sums.reasoning,
      usd: sums.estimatedCost,
      observableUsd: sums.observableCost,
      precision: "estimated",
    };
  }

  async recordEvent(event: CursorHookEvent): Promise<void> {
    const db = openDb();
    const eventType = String(event.hook_event_name ?? "unknown");
    const timestamp = new Date().toISOString();

    if (eventType === "preCompact") {
      const content = JSON.stringify({
        context_tokens: event.context_tokens,
        context_window_size: event.context_window_size,
        context_usage_percent: event.context_usage_percent,
      });
      withImmediate(db, () => {
        insertContextSnapshot(db, {
          timestamp,
          conversation_id: event.conversation_id,
          generation_id: event.generation_id,
          context_tokens: numberOrUndefined(event.context_tokens),
          context_window_size: numberOrUndefined(event.context_window_size),
          context_usage_percent: numberOrUndefined(event.context_usage_percent),
          trigger: event.trigger,
          metadata: content,
          dedupe_key: makeDedupeKey(event.generation_id, eventType, content, {
            conversationId: event.conversation_id,
            timestamp,
          }),
        });
      });
      return;
    }

    const row = this.toUsageRow(event, timestamp);
    if (!row) return;
    withImmediate(db, () => {
      insertUsageEvent(db, row);
    });
  }

  private toUsageRow(event: CursorHookEvent, timestamp: string): UsageRow | null {
    const eventType = String(event.hook_event_name ?? "unknown");
    const model = event.model_id || event.model;
    const { rate, matched } = resolveRate(model, this.config);
    const multiplier = this.config.accounting.safetyMultiplier;

    let input = 0;
    let output = 0;
    let reasoning = 0;
    let content = "";

    if (eventType === "beforeSubmitPrompt") {
      content = String(event.prompt ?? "");
      input = countObservableTokens(content);
    } else if (eventType === "afterAgentThought") {
      content = String(event.text ?? "");
      reasoning = countObservableTokens(content);
    } else if (eventType === "afterAgentResponse") {
      content = String(event.text ?? "");
      output = countObservableTokens(content);
    } else {
      return null;
    }

    const observable = input + output + reasoning;
    const observableCost = costUsd({ input, output, reasoning }, rate);
    return {
      timestamp,
      conversation_id: event.conversation_id,
      generation_id: event.generation_id,
      event_type: eventType,
      model: event.model,
      model_id: event.model_id,
      observable_input_tokens: input,
      observable_output_tokens: output,
      observable_reasoning_tokens: reasoning,
      estimated_tokens: Math.round(observable * multiplier),
      observable_cost_usd: observableCost,
      estimated_cost_usd: observableCost * multiplier,
      metadata: JSON.stringify({ matched, model: model ?? null }),
      dedupe_key: makeDedupeKey(event.generation_id, eventType, content, {
        conversationId: event.conversation_id,
        timestamp,
      }),
    };
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
