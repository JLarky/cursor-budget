/**
 * Fixture transcripts shaped after real Claude Code / Codex session files
 * (identifiers redacted). Embedded as strings so the compiled tests stay
 * self-contained.
 */

export const CLAUDE_FIXTURE_JSONL = [
  '{"parentUuid":null,"isSidechain":false,"message":{"role":"user","content":"hi"},"type":"user","uuid":"u1","timestamp":"2026-08-19T22:00:00.000Z","cwd":"/work/project","sessionId":"claude-session-1","version":"2.0.0"}',
  '{"parentUuid":"u1","isSidechain":false,"message":{"id":"msg_claude_1","model":"claude-sonnet-5","type":"message","role":"assistant","content":[{"type":"text","text":"working"}],"stop_reason":"tool_use","usage":{"input_tokens":12,"cache_creation_input_tokens":400,"cache_read_input_tokens":300,"output_tokens":150,"output_tokens_details":{"thinking_tokens":50}}},"requestId":"req_1","type":"assistant","uuid":"a1","timestamp":"2026-08-19T22:00:05.123Z","cwd":"/work/project","sessionId":"claude-session-1","version":"2.0.0"}',
  '{"parentUuid":"a1","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"type":"user","uuid":"u2","timestamp":"2026-08-19T22:00:06.000Z","cwd":"/work/project","sessionId":"claude-session-1","version":"2.0.0"}',
  '{"parentUuid":"u2","isSidechain":false,"message":{"id":"msg_claude_1","model":"claude-sonnet-5","type":"message","role":"assistant","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn","usage":{"input_tokens":20,"cache_creation_input_tokens":500,"cache_read_input_tokens":900,"output_tokens":210}},"requestId":"req_2","type":"assistant","uuid":"a2","timestamp":"2026-08-19T22:00:07.456Z","cwd":"/work/project","sessionId":"claude-session-1","version":"2.0.0"}',
  '{"type":"summary","summary":"fixture session","leafUuid":"a2"}',
].join("\n");

export const CODEX_FIXTURE_JSONL = [
  '{"timestamp":"2026-08-15T21:57:46.545Z","type":"session_meta","payload":{"session_id":"codex-session-1","id":"codex-session-1","timestamp":"2026-08-15T21:57:46.320Z","cwd":"/work/codex-project","originator":"codex_exec","cli_version":"0.147.0","model_provider":"openai"}}',
  '{"timestamp":"2026-08-15T21:57:47.000Z","type":"turn_context","payload":{"cwd":"/work/codex-project","model":"gpt-5.6-codex","effort":"high","summary_limit":null}}',
  '{"timestamp":"2026-08-15T21:57:48.746Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":15044,"cached_input_tokens":9984,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":15049},"last_token_usage":{"input_tokens":15044,"cached_input_tokens":9984,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":15049},"model_context_window":258400},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":10.0,"window_minutes":10080,"resets_at":1787236649},"secondary":null,"plan_type":"plus"}}}',
  '{"timestamp":"2026-08-15T21:58:10.100Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":26044,"cached_input_tokens":12000,"cache_write_input_tokens":0,"output_tokens":305,"reasoning_output_tokens":120,"total_tokens":26349},"last_token_usage":{"input_tokens":11000,"cached_input_tokens":2016,"cache_write_input_tokens":0,"output_tokens":300,"reasoning_output_tokens":120,"total_tokens":11304},"model_context_window":258400},"rate_limits":{"limit_id":"codex","primary":{"used_percent":11.5,"window_minutes":10080,"resets_at":1787236649},"plan_type":"plus"}}}',
  '{"timestamp":"2026-08-15T21:58:11.000Z","type":"event_msg","payload":{"type":"agent_message","message":"done"}}',
].join("\n");
