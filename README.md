# llm-budget

Usage guards for **Cursor Agent**, **Claude Code**, and **Codex** — each stops
its agent before you burn through your quota, using real reported usage as the
source of truth, never a local estimate.

One binary, one tool per agent:

```sh
llm-budget cursor status   # Cursor Agent  — dashboard API metering
llm-budget claude install  # Claude Code   — transcript metering + native hooks
llm-budget codex install   # Codex         — transcript metering + shim + watchdog
```

**Repository:** https://github.com/JLarky/llm-budget

## Why not estimate tokens locally?

An earlier version of this tool did, and it was wrong by roughly 12x. Hooks
don't see the real prompt payload — system prompts, file context, cache reads
and reasoning tokens are all invisible — so any local estimate is guessing at
the majority of the bill. Every guard here reads numbers the provider actually
billed: the Cursor dashboard API for `cursor`, and API-reported token usage
stamped into local transcripts for `claude` and `codex`.

## Install

Requires Node >= 22.5 (for `node:sqlite`).

```sh
git clone https://github.com/JLarky/llm-budget.git
cd llm-budget
npm install
npm run build

llm-budget cursor install    # register Cursor hooks
llm-budget claude install    # register Claude Code hooks
llm-budget codex install     # write the Codex PATH shim (then add it to PATH)
```

### Cursor Agent scope

`llm-budget cursor install` writes a wrapper to `~/.cursor/hooks/llm-budget` and registers
it in `~/.cursor/hooks.json`. On every prompt and tool call it checks real
usage from the Cursor dashboard API and denies requests past your threshold.
Undo with `llm-budget cursor uninstall`.

```
$ llm-budget cursor status
llm-budget (cursor)

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

Authentication piggybacks on the Cursor Agent CLI: sign in with `cursor-agent`
and the guard reads `~/.config/cursor/auth.json`. You can override with
`CURSOR_ACCESS_TOKEN`. The token is never logged, printed, or copied into the
local database — only the usage snapshot is cached.

## How it decides (cursor)

Two gates, in separate failure domains:

| Gate | Source | Purpose |
|---|---|---|
| **Quota** | Cursor dashboard API | the real limit — blocks at `%` of your plan |
| **Rate** | local SQLite event count | runaway-loop catch, `500` events/hour |

An **override** (`llm-budget cursor override 30m`) or a per-session
**exception** (`llm-budget cursor except add <session-id>`) bypasses both. Every block message
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

## Configuration (cursor)

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

Cursor-scope commands (also available from `llm-budget cursor help`):

| Command | |
|---|---|
| `llm-budget cursor status` | current usage, thresholds, override state, credential expiry |
| `llm-budget cursor spending` | raw period usage from the API as JSON |
| `llm-budget cursor override <duration>` | temporarily bypass Cursor gates (e.g. `30m`) |
| `llm-budget cursor override off` | clear the Cursor override |
| `llm-budget cursor except add <session-id>` | permanently exempt a session |
| `llm-budget cursor except remove <session-id>` | remove a session exception |
| `llm-budget cursor except list` | list session exceptions |
| `llm-budget cursor history` | recorded local events |
| `llm-budget cursor config` | print resolved configuration |
| `llm-budget cursor install` | manage hook registration |
| `llm-budget cursor uninstall [--purge-data]` | remove hook registration |

## Claude Code & Codex scopes

The same guard philosophy extended to Claude Code CLI and Codex CLI. Instead
of polling a dashboard API, these scopes meter what the CLIs themselves report — every assistant turn is stamped
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
    // For USD, price models via `llm-budget import-rates <source-file>` (see below) or
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
denominator, models without rates make measured spend *missing money*, not
zero money — the guard treats that as unknown usage and blocks under the
default `failClosed: true` until you price them (`llm-budget import-rates <source-file>` or
inline `budget.rates`). Set `failClosed: false` if you would rather be warned
than blocked; `llm-budget status` always lists unpriced models either way.

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
llm-budget claude install               # registers UserPromptSubmit + PreToolUse in ~/.claude/settings.json
llm-budget claude uninstall
```

Every prompt and tool call re-reads transcripts and blocks once either gate
trips — the weekly cap or the rolling 5-hour window. The block protocol is
deliberately single-channel: a human-readable reason on **stderr** plus exit
code 2, which every Claude Code hook type honors (mixing in stdout JSON is
ambiguous across client versions). Fail-closed: broken config, unreadable hook
input, or unreadable state blocks with the session id and escape hatches
printed. Restart running sessions after install.

`Stop` is deliberately not hooked: it fires after the response is already
billed, and blocking it would only make Claude keep working.

### Codex enforcement

Codex has no deny hooks, so enforcement is layered, and honestly partial:

```sh
llm-budget codex install                # writes ~/.llm-budget/bin/codex shim
export PATH="$HOME/.llm-budget/bin:$PATH"   # put it in your shell profile
llm-budget watchdog                     # sidecar poller (default interval 15s)
```

- **Shim**: installed as a `codex` entrypoint; consults the guard, then execs
  the real binary. Gates *starting* Codex.
- **Watchdog**: re-evaluates every few seconds and SIGTERMs codex processes
  on **every poll** while the weekly cap remains exceeded — so a process that
  started later through an absolute path (bypassing the shim) or shrugged off
  the first SIGTERM is still caught. The desktop notification fires only on
  the trip transition, not each tick. Kills re-arm automatically when usage
  recovers (reset / override).
- Optional instead of the poller: register `notify` in `~/.codex/config.toml`
  to run `llm-budget codex-guard` after each turn.

**Known gaps:** a single long-running turn can overshoot between watchdog
ticks; anything that bypasses the shim (absolute paths, shell aliases made
before install) skips the startup gate entirely; the watchdog kills by process
matching, which could in principle miss renamed binaries. If you need hard
guarantees, keep the percentage conservative.

### Commands

| Command | |
|---|---|
| `llm-budget status` | per-tool window usage, thresholds, OpenAI's own Codex telemetry, Cursor Agent section |
| `llm-budget override <duration>` | temporarily bypass Claude + Codex gates (e.g. `30m`) |
| `llm-budget override off` | clear the Claude + Codex override |
| `llm-budget except add <session-id>` | exempt a session from counting and gating |
| `llm-budget except remove <session-id>` | remove a session exception |
| `llm-budget except list` | list session exceptions |
| `llm-budget history` | recent recorded token events |
| `llm-budget import-rates <source-file>` | build `~/.llm-budget/rates.json` from a models.dev catalog (e.g. token-tracker's `pricing-cache.json`) |
| `llm-budget claude install` | manage Claude Code hook registration |
| `llm-budget claude uninstall` | remove Claude Code hook registration |
| `llm-budget codex install` | install the Codex PATH shim |
| `llm-budget codex uninstall` | remove the Codex PATH shim |
| `llm-budget watchdog [--interval <duration>] [--once]` | stop running Codex sessions on trip |
| `llm-budget config` | print resolved configuration |

State lives in `~/.llm-budget/` (config, SQLite event store, rates) for the
claude and codex scopes; the cursor scope keeps its own state in
`~/.cursor/llm-budget/`. Override and exceptions are scoped per store —
`llm-budget override` unblocks claude+codex, `llm-budget cursor override`
unblocks Cursor — so unblocking one tool never silently unblocks another.

## Development

```sh
npm test   # tsc + node --test
```

Tests never make authenticated network calls — `fetch` and `home` are injected.

## License

MIT
