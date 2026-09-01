/** Cursor Agent override deadline. Distinct from Claude/Codex `override_until`. */
export const CURSOR_OVERRIDE_KEY = "cursor_override_until";

/** Grok CLI override deadline. Distinct from `override_until` and `cursor_override_until`. */
export const GROK_OVERRIDE_KEY = "grok_override_until";

/** Cached `GrokWeekly` reading (never the bearer token). Its own row, not a shared blob. */
export const GROK_WEEKLY_CACHE_KEY = "grok_weekly_v1";
