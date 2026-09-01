# llm-budget

Usage guards for **Claude Code**, **Codex**, and **Cursor Agent** — each stops
its agent before you burn through your quota, using real reported usage as the
source of truth, never a local estimate.

One binary, one scope per agent:

```sh
llm-budget claude install  # Claude Code   — Anthropic usage API + native hooks
llm-budget codex install   # Codex         — OpenAI usage API + native hooks
llm-budget cursor install  # Cursor Agent  — dashboard API + ~/.cursor/hooks.json
```

**Repository:** https://github.com/JLarky/llm-budget

## Why not estimate tokens locally?

An earlier version of this tool did, and it was wrong by roughly 12x. Hooks
don't see the real prompt payload — system prompts, file context, cache reads
and reasoning tokens are all invisible — so any local estimate is guessing at
the majority of the bill. Every guard here reads numbers the provider actually
reports: Anthropic's OAuth usage API for `claude`, OpenAI's rate-limit
telemetry for `codex`, and the Cursor dashboard API for `cursor`.

## Install

Requires Node >= 22.5 (for `node:sqlite`).

```sh
git clone https://github.com/JLarky/llm-budget.git
cd llm-budget
npm install
npm run build

llm-budget claude install    # register Claude Code hooks
llm-budget codex install     # register Codex native hooks
llm-budget cursor install    # register Cursor Agent hooks
```

## How it decides

Each agent has a percent gate against provider-reported usage, plus escape
hatches (override and per-session exceptions). If usage cannot be determined
the guard **blocks** by default (`failClosed: true`). Turn that off in config
if you would rather not be interrupted.

An override or a per-session exception bypasses the gates. Block messages
print the session id and the recover commands, so you are never stuck without
a way back in. Override and exceptions are per store — unblocking one agent
never silently unblocks another.

### Claude Code

`llm-budget claude install` registers `UserPromptSubmit` + `PreToolUse` in
`~/.claude/settings.json`. Every prompt and tool call re-checks Anthropic's
usage API and
blocks once either gate trips — the weekly cap or the rolling 5-hour window.
The block protocol is a human-readable reason on **stderr** plus exit code 2.
Undo with `llm-budget claude uninstall`. Restart running sessions after
install.

`Stop` is deliberately not hooked: it fires after the response is already
billed, and blocking it would only make Claude keep working.

### Codex

Codex enforcement uses native hooks:

```sh
llm-budget codex install                # writes ~/.codex/hooks.json
```

Native `UserPromptSubmit` and `PreToolUse` hooks deny with stderr and exit 2.
After installation, Codex's startup hook review must trust the hooks before
they execute; until that interactive review is completed, hooks are
`untrusted` and Codex will skip them (including in `codex exec`). The status
output calls this out. The watchdog is optional and is never installed
automatically.

To verify a hook in non-interactive CI, use Codex's explicit trust override:
`codex exec --dangerously-bypass-hook-trust "hi"`. A blocked run prints
`hook: UserPromptSubmit Blocked` before any model request.

**Known gaps:** Codex `UserPromptSubmit` historically fails open if a hook
crashes or times out, so `failClosed` cannot make Codex itself fail closed.
`PreToolUse` is Bash-first and file/MCP tools may not fire; `UserPromptSubmit`
is the reliable next-turn gate. `notify` is fire-and-forget after billing and
is not a primary gate.

### Cursor Agent

`llm-budget cursor install` writes a wrapper to `~/.cursor/hooks/llm-budget`
and registers it in `~/.cursor/hooks.json`. On every prompt and tool call it
checks real usage from the Cursor dashboard API and denies requests past your
threshold. Undo with `llm-budget cursor uninstall`.

```
$ llm-budget cursor status
llm-budget
Config: ~/.config/llm-budget/config.jsonc
On unknown usage: block (failClosed)

Cursor Models: 1.38% (block at 90%)
Other Models: 0% (block at 90%)
Total: 1.0% (monitor-only)
Period spend:
  $27.51 / $400.00
Cycle resets: 9/17/2026, 9:26:51 PM
Snapshot: network, age 0ms

Last 60 minutes
  Events: 3 / 500

Credential: expires in 50d (10/9/2026)
Override: none
```

Authentication piggybacks on the Cursor Agent CLI: sign in with `cursor-agent`
and the guard reads `~/.config/cursor/auth.json`. You can override with
`CURSOR_ACCESS_TOKEN`. The token is never logged, printed, or copied into the
local database — only the usage snapshot is cached.

Two gates, in separate failure domains:

| Gate | Source | Purpose |
|---|---|---|
| **Usage windows** | Cursor dashboard API | plan meters — block at `%` when configured |
| **Event rate** | local SQLite event count | runaway-loop backstop, `500` events/hour |

Cursor's `hooks.json` has its own unrelated `failClosed` field, which governs
what Cursor does when the hook *process* fails. `install` sets it to `false`
so a crash in this tool cannot lock up your editor.

You also get a notification as your Cursor credential nears expiry, since an
expired token means the guard starts blocking.

## Configuration

One file for every agent: `~/.config/llm-budget/config.jsonc`.

Every provider uses the same shape: `enabled` plus a `windows` map. Each window
has `blockAtPercent`: a number enforces at that threshold, `null` is
monitor-only (measured and shown in status, never blocks). Window names match
what each vendor reports. There is no inheritance between windows.

Invalid config fails closed on enforcement paths — broken files are rejected
with a visible error, not silently replaced with defaults.

```jsonc
{
  "claude": {
    "enabled": true,
    "windows": {
      "weekly": { "blockAtPercent": 80 },
      "five_hour": { "blockAtPercent": 80 }
    }
  },
  "codex": {
    "enabled": true,
    "windows": {
      "weekly": { "blockAtPercent": 80 },
      "session": { "blockAtPercent": null }
    }
  },
  "cursor": {
    "enabled": true,
    "windows": {
      "cursorModels": { "blockAtPercent": 90 },
      "otherModels": { "blockAtPercent": 90 },
      "total": { "blockAtPercent": null }
    },
    "rateLimit": { "maxEventsPerHour": 500 },
    "maxStaleMs": 3600000,
    "cacheTtlMs": 90000,
    "warnings": [0.5, 0.75, 0.9],
    "excludeConversationIds": []
  },
  "enforcement": { "failClosed": true },
  "excludeSessionIds": []
}
```

Window reference:

| Key | Agent | Vendor window |
|---|---|---|
| `claude.windows.weekly` | Claude Code | 7-day rolling cap |
| `claude.windows.five_hour` | Claude Code | rolling 5-hour cap |
| `codex.windows.weekly` | Codex | OpenAI weekly rate limit |
| `codex.windows.session` | Codex | OpenAI 5-hour session (monitor-only by default) |
| `cursor.windows.cursorModels` | Cursor Agent | dashboard "Cursor Models" meter |
| `cursor.windows.otherModels` | Cursor Agent | dashboard "Other Models" meter |
| `cursor.windows.total` | Cursor Agent | combined spend meter (monitor-only by default) |

`cursor.rateLimit.maxEventsPerHour` is the event-rate backstop (not a budget
window). Set it to `null` to disable.

Percentages come from the vendor usage APIs (Claude Code's local OAuth
creds, Codex `auth.json`, Cursor dashboard). Each enforced window blocks when
usage reaches its threshold. If usage cannot be determined the guards block under
the default `failClosed: true`.

Warnings fire as desktop notifications once per threshold per billing cycle.

```jsonc
// turn fail-closed off if you would rather not be interrupted
{ "enforcement": { "failClosed": false } }
```

## Commands

Every agent supports `install | uninstall | help` under its scope.

| Command | |
|---|---|
| `llm-budget` / `status` / `usage` | all three agents |
| `llm-budget claude install` | register Claude Code hooks |
| `llm-budget claude uninstall` | remove Claude Code hooks |
| `llm-budget codex install` | register Codex native hooks |
| `llm-budget codex uninstall` | remove Codex native hooks |
| `llm-budget cursor install` | register Cursor Agent hooks |
| `llm-budget cursor uninstall [--purge-data]` | remove Cursor Agent hooks |
| `llm-budget watchdog [--interval <duration>] [--once]` | stop running Codex sessions on trip |

Claude Code, Codex, and Cursor Agent share `~/.config/llm-budget/config.jsonc`.
Cursor Agent still uses `llm-budget cursor ...` for dashboard-specific
commands, and its hooks still register in `~/.cursor/hooks.json`.

| Claude Code + Codex | Cursor Agent | |
|---|---|---|
| `llm-budget override <duration>` | `llm-budget cursor override <duration>` | temporarily bypass gates |
| `llm-budget override off` | `llm-budget cursor override off` | clear the override |
| `llm-budget except add <session-id>` | `llm-budget cursor except add <session-id>` | exempt a session |
| `llm-budget except remove <session-id>` | `llm-budget cursor except remove <session-id>` | remove an exception |
| `llm-budget except list` | `llm-budget cursor except list` | list exceptions |
| `llm-budget config` | `llm-budget cursor config` | print resolved configuration |
| | `llm-budget cursor status` | dashboard usage, thresholds, credential expiry |
| | `llm-budget cursor spending` | raw period usage from the API as JSON |
| | `llm-budget cursor history` | recorded local events |

## Development

```sh
npm test   # tsc + node --test
```

Tests never make authenticated network calls — `fetch` and `home` are injected.

## License

MIT
