# Fail-closed hooks

When a hooked agent submits a prompt or tool call, llm-budget reads usage and denies the event if a gate trips or if usage cannot be determined and `failClosed` is on. Isolated HOME has no credentials, so the default proof is a deny with an unknown-usage reason and the recover commands.

## Sub-features

- `hook-cursor-deny` denies Cursor enforce events with JSON `permission: deny` when dashboard usage is unavailable.
- `hook-claude-deny` blocks Claude UserPromptSubmit / PreToolUse with stderr plus exit 2.
- `hook-codex-deny` blocks Codex UserPromptSubmit / PreToolUse with stderr plus exit 2.
- `hook-recover` prints session id and `override` / `except add` commands on the deny path.
- `hook-record-allow` allows Cursor `afterAgentThought` / `afterAgentResponse` even when usage is unknown.

## How to get to it (user POV)

- Claude Code fires `UserPromptSubmit` and `PreToolUse` after `llm-budget claude install`.
- Codex fires the same event names after `llm-budget codex install`.
- Cursor Agent fires `beforeSubmitPrompt`, `preToolUse`, and the other enforce events after `llm-budget cursor install`.
- A user reproduces a hook without the agent by piping JSON to `llm-budget claude hook`, `codex hook`, or `cursor hook`. That is the same binary the wrappers exec.

## Driving it with verify-llm-budget

Preconditions:

- `verify-llm-budget doctor` prints `doctor: ok`.
- Isolated HOME has default config (`failClosed: true`) and no Cursor `auth.json`, no Codex `auth.json`, no Claude `.credentials.json`.
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

- **Proof.** Keep `fail-closed/cursor-preToolUse/stdout.txt` and `fail-closed/claude-submit/stderr.txt` plus `exit.txt` showing `2`. Do not treat a Cursor JSON deny as an exit-2 proof, and do not treat a Claude exit 2 as a JSON deny.

## Gotchas

- Claude and Codex block with **stderr + exit 2**. Cursor blocks with **stdout JSON** and exit 0. Mixing those assertions is the usual false failure.
- Empty stdin: Claude and Codex fail closed (exit 2, "hook produced no input"). Cursor treats empty stdin as `{}` and **allows**. Always pipe a JSON object.
- Cursor hook stdin times out after 2s and then allows. Do not start `cursor hook` and wait.
- `verify-llm-budget hook` is a convenience that builds JSON. The user-facing wrapper path is still `node dist/llm/cli.js <scope> hook` with stdin. After install, proving the wrapper means execing `$VERIFY_HOME/.cursor/hooks/llm-budget` (or the claude/codex wrapper) with `HOME` still isolated.
- On macOS, Claude may read Keychain OAuth and either allow (under budget) or deny (over budget) instead of unknown-usage. Cursor and Codex stay isolated. Prefer Cursor for a portable fail-closed proof. If Claude allows on darwin, record Keychain as the unmet isolation precondition. Do not call that a product regression by itself.
- Turning `enforcement.failClosed` to `false` in config.jsonc changes this recipe. Re-read the file before asserting a deny.
- Do not run these hooks against the real user HOME. A deny there blocks the agent that is running this verification.
