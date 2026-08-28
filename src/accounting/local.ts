import type { Config } from "../config.js";
import {
  countEvents,
  insertUsageEvent,
  makeDedupeKey,
  openDb,
  withImmediate,
  type UsageRow,
} from "../db/client.js";
import type { AccountingProvider, CursorHookEvent } from "./types.js";

/** Records hook events for the local event-count backstop (no cost estimation). */
export class LocalEventAccountingProvider implements AccountingProvider {
  constructor(
    private readonly config: Config,
    private readonly home?: string,
  ) {}

  async countEvents(window: { from: Date; to: Date }): Promise<number> {
    const db = openDb(this.home);
    return countEvents(db, window.from, window.to, this.config.cursor.excludeConversationIds);
  }

  async recordEvent(event: CursorHookEvent): Promise<void> {
    const row = this.toUsageRow(event, new Date().toISOString());
    if (!row) return;
    const db = openDb(this.home);
    withImmediate(db, () => {
      insertUsageEvent(db, row);
    });
  }

  private toUsageRow(event: CursorHookEvent, timestamp: string): UsageRow | null {
    const eventType = String(event.hook_event_name ?? "unknown");
    let content = "";

    if (eventType === "beforeSubmitPrompt") {
      content = String(event.prompt ?? "");
    } else if (eventType === "afterAgentThought" || eventType === "afterAgentResponse") {
      content = String(event.text ?? "");
    } else {
      return null;
    }

    const model = event.model_id || event.model;
    return {
      timestamp,
      conversation_id: event.conversation_id,
      generation_id: event.generation_id,
      event_type: eventType,
      model,
      dedupe_key: makeDedupeKey(event.generation_id, eventType, content, {
        conversationId: event.conversation_id,
        timestamp,
      }),
    };
  }
}
