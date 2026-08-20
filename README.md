# cursor-budget

A guard that stops Cursor Agent before you burn through your plan quota — using
Cursor's own reported usage as the source of truth, not a local estimate.

**Repository:** https://github.com/JLarky/cursor-limit

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
git clone https://github.com/JLarky/cursor-limit.git
cd cursor-limit
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

## Development

```sh
npm test   # tsc + node --test
```

Tests never make authenticated network calls — `fetch` and `home` are injected.

## License

MIT
