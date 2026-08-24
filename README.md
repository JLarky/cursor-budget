# cursor-budget

A guard that stops Cursor Agent before you burn through your plan quota — using
Cursor's own reported usage as the source of truth, not a local estimate.

**Repository:** https://github.com/JLarky/cursor-budget

It installs as a set of [Cursor hooks](https://cursor.com/docs/agent/hooks). On
every prompt and tool call it checks your real usage from the Cursor dashboard
API, and denies the request once you cross a threshold you set.

```
$ cursor-budget status
cursor-budget

Cursor Models (auto):
  1.38%  (block at 90%)
Other Models (api):
  0%  (block at 90%)
Period spend:
  $27.51 / $400.00
Cycle resets: 9/17/2026, 9:26:51 PM
Snapshot: network, age 0ms

Last 60 minutes
  Events: 3 / 500

Credential: expires in 50d (10/9/2026)
On unknown usage: block (failClosed)
Override: none
```

## Why not estimate tokens locally?

An earlier version of this tool did, and it was wrong by roughly 12x. Hooks
don't see the real prompt payload — system prompts, file context, cache reads
and reasoning tokens are all invisible — so any local estimate is guessing at
the majority of the bill. This reads the number Cursor bills you against.

## Install

Requires Node >= 22.5 (for `node:sqlite`).

```sh
git clone https://github.com/JLarky/cursor-budget.git
cd cursor-budget
npm install
npm run build
node dist/cli.js install
```

`install` writes a wrapper to `~/.cursor/hooks/cursor-budget` and registers it
in `~/.cursor/hooks.json`. Undo with `cursor-budget uninstall`.

Authentication piggybacks on the Cursor Agent CLI: sign in with `cursor-agent`
and the guard reads `~/.config/cursor/auth.json`. You can override with
`CURSOR_ACCESS_TOKEN`. The token is never logged, printed, or copied into the
local database — only the usage snapshot is cached.

## How it decides

Two gates, in separate failure domains:

| Gate | Source | Purpose |
|---|---|---|
| **Quota** | Cursor dashboard API | the real limit — blocks at `%` of your plan |
| **Rate** | local SQLite event count | runaway-loop catch, `500` events/hour |

An **override** (`cursor-budget override 30m`) or a per-session **exception**
(`cursor-budget except add <session-id>`) bypasses both. Every block message
prints the session id and those two commands, so you are never stuck without a
way back in.

## Fail-closed by default

If usage cannot be determined — expired credential, API unreachable, cached
snapshot older than `maxStaleMs` — the guard **blocks**. A budget guard whose
failure mode is silently not guarding is worse than one that occasionally gets
in the way.

Turn it off if you would rather not be interrupted:

```jsonc
// ~/.cursor/llm-budget/config.json
{ "enforcement": { "failClosed": false } }
```

Note that Cursor's `hooks.json` has its own unrelated `failClosed` field, which
governs what Cursor does when the hook *process* fails. `install` sets it to
`false` so a crash in this tool cannot lock up your editor.

## Configuration

`~/.cursor/llm-budget/config.json`. Only overrides are stored; defaults live in
code. All keys optional.

```jsonc
{
  "quota": {
    "cursorModelsBlockAtPercent": 90,  // "Cursor Models" meter, 0-100
    "otherModelsBlockAtPercent": 90,   // "Other Models" meter, 0-100
    "totalBlockAtPercent": null,       // optional overall gate
    "maxStaleMs": 3600000,             // older snapshot => usage unknown
    "cacheTtlMs": 90000                // before trying the network again
  },
  "rateLimit": { "maxEventsPerHour": 500 },
  "warnings": [0.5, 0.75, 0.9],        // fractions of the block threshold, 0-1
  "enforcement": { "failClosed": true },
  "excludeConversationIds": []
}
```

Warnings fire as desktop notifications once per threshold per billing cycle.
You also get a notification as your Cursor credential nears expiry, since an
expired token means the guard starts blocking.

## Commands

| Command | |
|---|---|
| `status` | current usage, thresholds, override state, credential expiry |
| `spending` | raw period usage from the API as JSON |
| `override 15m\|30m\|1h\|off` | temporarily bypass all gates |
| `except add\|remove\|list <id>` | permanently exempt a session |
| `history` | recorded local events |
| `config` | print resolved configuration |
| `install` / `uninstall [--purge-data]` | manage hook registration |

## Claude Code & Codex (`llm-budget`)

The same guard philosophy extended to Claude Code CLI and Codex CLI, shipped as
a second binary in this repo: `llm-budget`. Instead of polling a dashboard API,
it meters what the CLIs themselves report — every assistant turn is stamped
with **API-reported token usage** in local JSONL transcripts, so the numbers
are real, not estimates:

| Tool | Transcripts | Usage fields |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` |
| Codex | `~/.codex/sessions/**/*.jsonl`, `~/.codex/archived_sessions/**/*.jsonl` | per-call `last_token_usage`: input/output/reasoning/cached |

Parsing follows the same rules as
[token-tracker](https://github.com/JLarky/fork-token-tracker) (Codex's cached
input and reasoning are subsets of their parent counters and are subtracted;
cumulative `total_token_usage` lines are ignored; streamed duplicates of one
message collapse into the fullest snapshot). Scans are checkpointed by file
size + mtime, so re-checking between prompts only stats unchanged files.

### Budget denominator

Percentages are against a budget you define — explicit, not implied:

```jsonc
// ~/.llm-budget/config.json
{
  "budget": {
    // Pick ONE:
    "denominator": { "kind": "tokens", "weeklyTokens": 10000000 }
    // "denominator": { "kind": "usd", "weeklyUsd": 35 },
    //
    // For USD, price models via `llm-budget import-rates` (see below) or
    // inline rates ($/1M tokens):
    // "rates": { "claude-sonnet-5": { "input": 3, "output": 15 } }
  },
  "claudeCode": {
    "weeklyBlockAtPercent": 80,
    "rolling5hBlockAtPercent": 80,
    "rollingWindowMs": 18000000   // 5h; configurable if you want a different window
  },
  "codex": {
    "weeklyBlockAtPercent": 80
  },
  "enforcement": { "failClosed": true },
  "excludeSessionIds": []
}
```

Token totals count every billed bucket (input + output + reasoning + cache
read + cache write), matching what your provider actually meters. With a USD
denominator, models without rates are reported as `unpriced` in `status` —
they cost $0 in the math rather than being guessed, which means an incomplete
rate table can only under-block. Keep an eye on that warning.

### Weekly boundary (pinned UTC week)

OpenAI does not document Codex's exact weekly reset anchor, so this guard pins
**Monday 00:00 UTC** for both tools' weekly windows. It is deterministic
across machines and timezones; the worst case is a week that rolls a few days
away from OpenAI's. Codex also stamps its own weekly telemetry onto token
events; `llm-budget status` shows OpenAI's reported percent + reset time next
to ours so you can cross-check, but the configured denominator stays the gate.

### Claude Code enforcement

Claude Code hooks support blocking natively:

```sh
npm run build
node dist/llm/cli.js claude install     # registers UserPromptSubmit + PreToolUse in ~/.claude/settings.json
node dist/llm/cli.js claude uninstall
```

Every prompt and tool call re-reads transcripts and blocks (exit code 2 plus a
JSON decision) once either gate trips — the weekly cap or the rolling 5-hour
window. Fail-closed: broken config or unreadable state blocks with the session
id and escape hatches printed. Restart running sessions after install.

`Stop` is deliberately not hooked: it fires after the response is already
billed, and blocking it would only make Claude keep working.

### Codex enforcement

Codex has no deny hooks, so enforcement is layered, and honestly partial:

```sh
node dist/llm/cli.js codex install      # writes ~/.llm-budget/bin/codex shim
export PATH="$HOME/.llm-budget/bin:$PATH"   # put it in your shell profile
node dist/llm/cli.js watchdog           # sidecar poller (default: every 15s)
```

- **Shim**: installed as a `codex` entrypoint; consults the guard, then execs
  the real binary. Gates *starting* Codex.
- **Watchdog**: re-evaluates while sessions run and SIGTERMs codex processes
  when the weekly cap trips. Kills are latched until usage recovers
  (reset / override) so one trip doesn't become a kill loop.
- Optional instead of the poller: register `notify` in `~/.codex/config.toml`
  to run `llm-budget codex-guard --kill` after each turn.

**Known gaps:** a single long-running turn can overshoot between watchdog
ticks; anything that bypasses the shim (absolute paths, shell aliases made
before install) skips the startup gate entirely; the watchdog kills by process
matching, which could in principle miss renamed binaries. If you need hard
guarantees, keep the percentage conservative.

### Commands

| Command | |
|---|---|
| `status` | per-tool window usage, thresholds, OpenAI's own Codex telemetry |
| `override 15m\|30m\|1h\|off` | temporarily bypass all gates |
| `except add\|remove\|list <session-id>` | exempt a session from counting and gating |
| `history` | recent recorded token events |
| `import-rates <models.dev-cache.json>` | build `~/.llm-budget/rates.json` from a models.dev catalog (e.g. token-tracker's `pricing-cache.json`) |
| `claude install\|uninstall` | manage Claude Code hook registration |
| `codex install\|uninstall` | manage the Codex PATH shim |
| `watchdog [--interval 15s] [--once]` | stop running Codex sessions on trip |
| `config` | print resolved configuration |

State lives in `~/.llm-budget/` (config, SQLite event store, rates). Override
and exceptions are shared by the two new tools but separate from
`cursor-budget`, whose strict config schema should not learn about agent keys.

## Development

```sh
npm test   # tsc + node --test
```

Tests never make authenticated network calls — `fetch` and `home` are injected.

## License

MIT
