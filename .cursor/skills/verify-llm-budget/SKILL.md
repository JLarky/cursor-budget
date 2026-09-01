---
name: verify-llm-budget
description: Drive the llm-budget CLI (status, install, config, override/except, fail-closed hooks) in an isolated HOME. Use when proving user-facing CLI or hook behavior after changing commands, install, config, or enforcement.
---

# Verify llm-budget

llm-budget is a Node CLI. Users run `llm-budget` to see usage, register hooks into Claude Code / Codex / Cursor Agent, and recover with override or session exceptions. There is no web UI.

This skill drives **this checkout's** `dist/llm/cli.js` under a throwaway `$HOME`. It never uses `llm-budget` from PATH and never writes `~/.claude`, `~/.codex`, `~/.cursor`, or `~/.config/llm-budget` of the real user.

Read `features/README.md` before picking a recipe. Drive the entry points that file lists, not a convenient internal function.

Helper path, from the repo root:

```sh
.cursor/skills/verify-llm-budget/bin/verify-llm-budget
```

The rest of this file shortens that to `verify-llm-budget`.

## Launch

No long-lived server. Launch means: build this checkout, then create one isolated home.

```sh
verify-llm-budget launch
```

That runs `npm install` if `node_modules` is missing, then `npm run build`, then `mktemp -d /tmp/llm-budget-verify-XXXXXX`. Ready when stdout prints `VERIFY_HOME=` and `CLI_JS=` ending in `dist/llm/cli.js`.

Requires Node >= 22.5 (`node:sqlite`). `package.json` engines field is the source of truth.

Teardown is `verify-llm-budget cleanup`. If launch fails partway, run cleanup anyway so `/tmp/llm-budget-verify-*` dirs do not pile up.

Two runs can exist only as two isolated homes. If `.run/current.env` already points at a live home, launch refuses. Cleanup that run first. Never point `HOME` at the real user home to "save a step".

## Doctor

Read-only. Run this first whenever status looks wrong, install wrote unexpected paths, or a previous run may have leaked.

```sh
verify-llm-budget doctor
```

It must print `doctor: ok`. It checks:

- Isolated `HOME` exists under `/tmp/llm-budget-verify-` and is not the real user home
- `dist/llm/cli.js` exists in this checkout
- Node is >= 22.5
- `llm-budget help` exits 0 and lists `claude`, `codex`, `cursor`, and `llm-budget install`
- Doctor uses `help` on purpose. `status` and `install` write `config.jsonc`. An empty home is expected only right after launch.

If doctor fails, stop. Do not install hooks "to see what happens".

## Drive

Every CLI invocation goes through the helper so `HOME` is the isolated dir and these env vars are unset: `CLAUDE_HOME`, `CODEX_HOME`, `CURSOR_ACCESS_TOKEN`.

```sh
verify-llm-budget cli -- status
verify-llm-budget cli -- help
verify-llm-budget cli -- install
verify-llm-budget hook claude UserPromptSubmit verify-sess-1
```

`cli --` is argv after `llm-budget`. `hook` builds the JSON the real agent would pipe on stdin.

Stable handles (assert these strings, not layout):

| What | Handle |
|---|---|
| Combined status | `llm-budget`, `llm-budget status`, `llm-budget usage` |
| Cursor-only status | `llm-budget cursor status` |
| All-agent install | `llm-budget install` |
| Per-agent install | `llm-budget claude install`, `codex install`, `cursor install` |
| Help | `llm-budget help`, `llm-budget claude help`, `codex help`, `cursor help` |
| Config print | `llm-budget config`, `llm-budget cursor config` |
| Claude/Codex override | `llm-budget override 15m`, `llm-budget override off` |
| Cursor override | `llm-budget cursor override 15m`, `llm-budget cursor override off` |
| Claude/Codex exceptions | `llm-budget except add <id>`, `except remove <id>`, `except list` |
| Cursor exceptions | `llm-budget cursor except add <id>`, `except remove <id>`, `except list` |
| Claude hook events | `UserPromptSubmit`, `PreToolUse` (stdin JSON, `session_id`) |
| Codex hook events | `UserPromptSubmit`, `PreToolUse` (stdin JSON, `session_id`) |
| Cursor enforce events | `beforeSubmitPrompt`, `preToolUse`, `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `subagentStart` (stdin JSON, `conversation_id`) |
| Cursor record events | `afterAgentThought`, `afterAgentResponse` |

Do not drive `llm-budget watchdog`. The watchdog SIGTERMs Codex processes on the machine by scanning the OS process list. Isolated `HOME` does not contain that blast radius.

Do not call `handleClaudeHook` / `handleHook` from tests as a substitute for the CLI. The user path is the compiled binary plus stdin.

## Evidence

Proof goes in `.cursor/skills/verify-llm-budget/evidence/<run-id>/`. Cleanup does not delete that directory. `<run-id>` is the basename of the isolated home (printed by `launch`).

```sh
verify-llm-budget capture install/after-status -- status
verify-llm-budget snapshot-home install/home
```

`capture` writes `cmd.txt`, `home.txt`, `stdout.txt`, `stderr.txt`, `exit.txt` even when the CLI exits non-zero (hooks block with 2). `snapshot-home` copies config and hook files out of the isolated home.

Proof standards:

- Exercise the real CLI path. No `runGuard({ fetchUsage })`, no editing sqlite by hand to fake a trip, no test-only endpoints.
- Capture the command and the resulting state. A final screen of `status` is not enough for `install`: snapshot the hook files too.
- Side effects live under isolated HOME only: `~/.config/llm-budget/config.jsonc`, `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.cursor/hooks.json`, wrappers under `~/.local/share/llm-budget/bin/` and `~/.cursor/hooks/llm-budget`.
- Isolated HOME has no vendor credentials. `status` showing "not signed in" / "unavailable" is expected. That is not a failed proof unless the recipe required live usage.
- Do not mock fetch. If a recipe needs a tripped percent gate, say so in the feature file and skip when credentials are absent. Fail-closed-without-creds is the recipe that is always available.

Record the feature id and entry point in the capture stem (`install/all-agents`, `fail-closed/cursor-preToolUse`).

## Cleanup

```sh
verify-llm-budget cleanup
```

Removes only the isolated home named in `.run/current.env`, then deletes that state file. It refuses if `VERIFY_HOME` is not under `/tmp/llm-budget-verify-`. It does not kill processes by name. It does not delete `evidence/`.

After cleanup, confirm the evidence directory from `launch` still exists.

## Helpers

`bin/verify-llm-budget` is executable. Commands:

```sh
verify-llm-budget launch
verify-llm-budget doctor
verify-llm-budget cli -- status
verify-llm-budget hook cursor preToolUse verify-sess-1
verify-llm-budget capture status/bare -- status
verify-llm-budget snapshot-home install/home
verify-llm-budget home-file .claude/settings.json
verify-llm-budget cleanup
```

`home-file` reads a relative path inside isolated HOME. It rejects `..` and absolute paths.
