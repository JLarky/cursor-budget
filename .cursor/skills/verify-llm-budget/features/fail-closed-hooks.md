# Fail-closed hooks

When a hooked agent submits a prompt or tool call, llm-budget reads usage and denies the event if a gate trips or if usage cannot be determined and `failClosed` is on. Isolated HOME has no credentials, so the default proof is a deny with an unknown-usage reason and the recover commands.

## Sub-features

- `hook-cursor-deny` denies Cursor enforce events with JSON `permission: deny` when dashboard usage is unavailable.
- `hook-claude-deny` blocks Claude UserPromptSubmit / PreToolUse with stderr plus exit 2.
- `hook-codex-deny` blocks Codex UserPromptSubmit / PreToolUse with stderr plus exit 2.
- `hook-grok-deny` denies Grok `pre_tool_use` with a `{"decision":"deny",...}` stdout JSON plus exit 2 when weekly credit usage is unavailable.
- `hook-grok-passive-allow` allows any Grok event other than `pre_tool_use` even when usage is unknown.
- `hook-recover` prints session id and `override` / `except add` commands on the deny path.
- `hook-record-allow` allows Cursor `afterAgentThought` / `afterAgentResponse` even when usage is unknown.

## How to get to it (user POV)

- Claude Code fires `UserPromptSubmit` and `PreToolUse` after `llm-budget claude install`.
- Codex fires the same event names after `llm-budget codex install`.
- Cursor Agent fires `beforeSubmitPrompt`, `preToolUse`, and the other enforce events after `llm-budget cursor install`.
- Grok CLI fires `pre_tool_use` after `llm-budget grok install`.
- A user reproduces a hook without the agent by piping JSON to `llm-budget claude hook`, `codex hook`, `cursor hook`, or `grok hook`. That is the same binary the wrappers exec.

## Driving it with verify-llm-budget

Preconditions:

- `verify-llm-budget doctor` prints `doctor: ok`.
- Isolated HOME has default config (`failClosed: true`) and no Cursor `auth.json`, no Codex `auth.json`, no Claude `.credentials.json`, no Grok `auth.json`.
- Install is not required. The hook subcommands exist on the CLI whether or not wrappers are registered. If you want wrapper proof, run the install feature first and exec the wrapper file with the same JSON on stdin.

- **Cursor enforce deny.** Run `verify-llm-budget capture fail-closed/cursor-preToolUse` by piping into `cli -- cursor hook`:

  ```sh
  printf '%s' '{"hook_event_name":"preToolUse","conversation_id":"verify-sess-1"}' \
    | verify-llm-budget capture fail-closed/cursor-preToolUse -- cursor hook
  ```

  Exit `0` (Cursor protocol returns JSON, process stays 0). stdout JSON has `"continue":false` and `"permission":"deny"`. `user_message` contains `Cursor Agent blocked by llm-budget.`, `Session id: verify-sess-1`, `Blocked because enforcement.failClosed is on (the default).`, and `llm-budget cursor except add verify-sess-1`.

- **Cursor record allow.** Pipe `{"hook_event_name":"afterAgentThought","conversation_id":"verify-sess-1"}` into `capture fail-closed/cursor-record -- cursor hook`. stdout JSON has `"permission":"allow"` and `"continue":true`.

- **Claude enforce deny.** Pipe JSON into the Claude hook subcommand (same argv the wrapper execs):

  ```sh
  printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"verify-sess-1"}' \
    | verify-llm-budget capture fail-closed/claude-submit -- claude hook
  ```

  `exit.txt` is `2`. stderr contains `Claude Code blocked by llm-budget.`, `Session id: verify-sess-1`, `Blocked because enforcement.failClosed is on (the default).`, and `llm-budget except add verify-sess-1`. stdout is empty. `verify-llm-budget hook claude UserPromptSubmit verify-sess-1` is the same payload without capturing.

- **Codex enforce deny.** Pipe `{"hook_event_name":"UserPromptSubmit","session_id":"verify-sess-1"}` into `capture fail-closed/codex-submit -- codex hook`, or `verify-llm-budget hook codex UserPromptSubmit verify-sess-1`. Exit `2`. stderr contains `Codex blocked by llm-budget.` and the same recover commands as Claude (`llm-budget override 30m`, `llm-budget except add verify-sess-1`).

- **Grok enforce deny.** Pipe JSON into the Grok hook subcommand (same argv the wrapper execs):

  ```sh
  printf '%s' '{"hookEventName":"pre_tool_use","sessionId":"verify-sess-1"}' \
    | verify-llm-budget capture fail-closed/grok-preToolUse -- grok hook
  ```

  Exit `2`. stdout is a single JSON line `{"decision":"deny","reason":"..."}`. `reason` contains `Grok CLI blocked by llm-budget. Session id: verify-sess-1.`, `Weekly usage is unavailable (no Grok auth.json — sign in with the grok CLI). Blocked because enforcement.failClosed is on.`, and `Recover with: llm-budget grok override 30m | llm-budget grok except add verify-sess-1 | llm-budget grok status`. stderr repeats the same reason text. `verify-llm-budget hook grok pre_tool_use verify-sess-1` is the same payload without capturing.

- **Grok passive allow.** Pipe `{"hookEventName":"afterAgentResponse","sessionId":"verify-sess-1"}` (any event other than `pre_tool_use`) into `capture fail-closed/grok-passive -- grok hook`. Exit `0`. stdout is empty — Grok's passive events cannot deny regardless of usage.

- **Proof.** Keep `fail-closed/cursor-preToolUse/stdout.txt`, `fail-closed/claude-submit/stderr.txt`, and `fail-closed/grok-preToolUse/stdout.txt` plus each `exit.txt`. Do not treat a Cursor JSON deny as an exit-2 proof, do not treat a Claude exit 2 as a JSON deny, and do not treat a Grok JSON deny as the same shape as Cursor's (different keys, different exit code).

## Gotchas

- Claude and Codex block with **stderr + exit 2**. Cursor blocks with **stdout JSON** and exit 0. Grok blocks with **stdout JSON `{"decision":"deny",...}`** and exit 2 — its own shape, distinct from both. Mixing those assertions is the usual false failure.
- Empty stdin: Claude, Codex, and Grok fail closed (exit 2, "produced no input" / "no input on stdin"). Cursor treats empty stdin as `{}` and **allows**. Always pipe a JSON object.
- Cursor hook stdin times out after 2s and then allows. Grok hook stdin times out after 2s and then proceeds with an empty payload, which fails closed as invalid JSON (not a silent allow). Do not start either and wait past that.
- Grok's own hook platform fails open on a crashed process; only the installed wrapper's deny envelope makes it fail closed end to end. Driving `grok hook` directly proves the Node-side decision, not the wrapper's missing-Node fallback — see `install.md` for that.
- Piping JSON into `llm-budget grok hook` does not prove Grok loaded `~/.grok/hooks/llm-budget.json`. The matching surface for "the Grok agent is blocked" is a live `grok` tool call after `llm-budget grok install`. That file must use nested `type: command` handlers. Isolated HOME never starts Grok.
- `verify-llm-budget hook` is a convenience that builds JSON. The user-facing wrapper path is still `node dist/llm/cli.js <scope> hook` with stdin. After install, proving the wrapper means execing `$VERIFY_HOME/.cursor/hooks/llm-budget` (or the claude/codex/grok wrapper) with `HOME` still isolated.
- On macOS, Claude may read Keychain OAuth and either allow (under budget) or deny (over budget) instead of unknown-usage. Cursor, Codex, and Grok stay isolated. Prefer Cursor or Grok for a portable fail-closed proof. If Claude allows on darwin, record Keychain as the unmet isolation precondition. Do not call that a product regression by itself.
- Turning `enforcement.failClosed` to `false` in config.jsonc changes this recipe. Re-read the file before asserting a deny.
- Do not run these hooks against the real user HOME. A deny there blocks the agent that is running this verification.
