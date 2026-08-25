import * as v from "valibot";

const percent0to100 = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100));
const nonNegativeFinite = v.pipe(v.number(), v.finite(), v.minValue(0));
const warningFraction = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1));

export const ClaudeCodeSchema = v.strictObject({
  enabled: v.optional(v.boolean()),
  weeklyBlockAtPercent: v.optional(percent0to100),
  rolling5hBlockAtPercent: v.optional(percent0to100),
});

export const CodexSchema = v.strictObject({
  enabled: v.optional(v.boolean()),
  weeklyBlockAtPercent: v.optional(percent0to100),
  openAiWeeklyBlockAtPercent: v.optional(v.nullable(percent0to100)),
});

export const QuotaSchema = v.strictObject({
  cursorModelsBlockAtPercent: v.optional(percent0to100),
  otherModelsBlockAtPercent: v.optional(percent0to100),
  totalBlockAtPercent: v.optional(v.nullable(percent0to100)),
  maxStaleMs: v.optional(nonNegativeFinite),
  cacheTtlMs: v.optional(nonNegativeFinite),
});

export const RateLimitSchema = v.strictObject({
  maxEventsPerHour: v.optional(v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0)))),
});

export const CursorSliceSchema = v.strictObject({
  quota: v.optional(QuotaSchema),
  rateLimit: v.optional(RateLimitSchema),
  warnings: v.optional(v.array(warningFraction)),
  enforcement: v.optional(
    v.strictObject({
      failClosed: v.optional(v.boolean()),
    }),
  ),
  excludeConversationIds: v.optional(v.array(v.string())),
});

/** One schema for the shared config.jsonc — every agent key is typed. */
export const ConfigFileSchema = v.strictObject({
  $schema: v.optional(v.string()),
  _comment: v.optional(v.string()),
  claudeCode: v.optional(ClaudeCodeSchema),
  codex: v.optional(CodexSchema),
  cursor: v.optional(CursorSliceSchema),
  // Top-level Cursor fields: writeConfig round-trips a resolved Config object.
  quota: v.optional(QuotaSchema),
  rateLimit: v.optional(RateLimitSchema),
  warnings: v.optional(v.array(warningFraction)),
  enforcement: v.optional(
    v.strictObject({
      failClosed: v.optional(v.boolean()),
    }),
  ),
  excludeSessionIds: v.optional(v.array(v.pipe(v.string(), v.trim(), v.minLength(1)))),
  excludeConversationIds: v.optional(v.array(v.string())),
});
