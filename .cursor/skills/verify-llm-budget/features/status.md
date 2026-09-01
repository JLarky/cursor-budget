# Status

Status prints a live budget view for Claude Code, Codex, and Cursor Agent: hook install state, usage windows when signed in, failClosed policy, and whether an override is active.

## Sub-features

- `status-combined` prints all three agent blocks from the bare invocation, `status`, and `usage`.
- `status-uninstalled` reports hooks as not installed with the matching install command.
- `status-cursor` prints the Cursor-only dashboard view.
- `status-help` lists the three peer scopes from `help`.

## How to get to it (user POV)

- Run `llm-budget` with no arguments.
- Run `llm-budget status`.
- Run `llm-budget usage` (alias of status).
- Run `llm-budget cursor status`.
- Run `llm-budget help`.

## Driving it with verify-llm-budget

Preconditions:

- `verify-llm-budget doctor` prints `doctor: ok`.
- Isolated HOME has no hook files yet.
- No vendor login files exist under isolated HOME.

- **Bare invocation.** Run `verify-llm-budget capture status/bare --` with no extra args. Exit `0`. stdout starts with `llm-budget`, includes `Config:` pointing at isolated HOME, `On unknown usage: block (failClosed)`, and headings `Claude Code:`, `Codex:`, `Cursor Agent:`. A trailing line tells the user to run `llm-budget help`.
- **status alias.** Run `verify-llm-budget capture status/status -- status`. Exit `0`. stdout matches the bare view except it does not include the help trailer.
- **usage alias.** Run `verify-llm-budget capture status/usage -- usage`. Exit `0`. stdout contains `Cursor Agent:`.
- **Uninstalled hooks.** In `status/status` stdout, Claude Code shows `Hooks: not installed — run llm-budget claude install`. Cursor Agent shows `Hooks: not installed — run llm-budget cursor install`. Each agent block contains `Override: none`.
- **Cursor-only status.** Run `verify-llm-budget capture status/cursor -- cursor status`. Exit `0`. stdout starts with `llm-budget`, includes the same Config path, and `Usage: unavailable` (no Cursor auth in isolated HOME). It includes `Credential:` and `Override: none`.
- **Help.** Run `verify-llm-budget capture status/help -- help`. Exit `0`. stdout contains `llm-budget install`, `llm-budget claude help`, `llm-budget codex help`, `llm-budget cursor help`, `llm-budget override `, and `llm-budget cursor override `.
- **Proof.** Keep `status/bare/stdout.txt` and `status/cursor/stdout.txt`. Both identify llm-budget and the isolated Config path.

## Gotchas

- Bare `llm-budget` appends a help hint that `status` does not. Compare aliases against `status`, not the bare view.
- Isolated HOME is not signed in. Combined status will say usage is unknown or unavailable. That is expected. Do not treat it as a broken build.
- `llm-budget cursor spending` hits the Cursor dashboard with `forceRefresh`. It fails without auth. It is not a status entry point.
- On macOS, Claude usage can still read the real Keychain even with isolated HOME. Cursor and Codex auth stay under HOME. If Claude windows show real percents during status, you are seeing the user's Keychain, not the fixture.
- `cursor status` is a different layout from the combined view. Do not grep combined headings out of it.
