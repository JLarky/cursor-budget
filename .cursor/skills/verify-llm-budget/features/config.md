# Config

Config is the shared `~/.config/llm-budget/config.jsonc` for every agent. Printing it shows the file path and contents. A broken file fails closed on enforcement and warns on status.

## Sub-features

- `config-print` prints the path plus file body from `config` and `cursor config`.
- `config-default` writes the documented default file the first time a command needs it (install, override, except, status).
- `config-invalid-status` keeps status usable with a warning when the file is invalid.
- `config-invalid-hook` denies enforce events when the file is invalid.

## How to get to it (user POV)

- Run `llm-budget config`.
- Run `llm-budget cursor config`.
- Edit `~/.config/llm-budget/config.jsonc` (window `blockAtPercent` numbers, `enforcement.failClosed`, exception lists).

## Driving it with verify-llm-budget

Preconditions:

- `verify-llm-budget doctor` prints `doctor: ok`.
- Isolated HOME has no config yet, or only the default file from a prior status in this run.

- **Create default.** Run `verify-llm-budget cli -- status` if the file is missing. Then `verify-llm-budget capture config/print -- config`. Exit `0`. stdout starts with the isolated path `…/.config/llm-budget/config.jsonc`, then the JSONC body. Body includes `"claude"`, `"codex"`, `"cursor"`, `"grok"`, and `"failClosed": true`.
- **Cursor alias.** Run `verify-llm-budget capture config/cursor-print -- cursor config`. Exit `0`. stdout matches `config/print` (same path, same body). There is no `grok config` alias — Grok shares this same file but only `llm-budget config` / `llm-budget cursor config` print it.
- **Invalid file, status still prints.** Overwrite isolated `config.jsonc` with `{not-json`. Run `verify-llm-budget capture config/invalid-status -- status`. Exit `0`. stdout contains `Warning: using defaults because config failed to load.` and still lists all four agents.
- **Invalid file, hook denies.** Keep the broken file. Run `verify-llm-budget capture config/invalid-hook --` by piping `{"hook_event_name":"preToolUse","conversation_id":"sess-bad-config"}` into `cli -- cursor hook`. stdout JSON has `"permission":"deny"` and `"continue":false`. `user_message` contains `failed to load config` and `Session id: sess-bad-config`.
- **Invalid file, Grok hook denies too.** Keep the broken file. Pipe `{"hookEventName":"pre_tool_use","sessionId":"sess-bad-config"}` into `verify-llm-budget cli -- grok hook`. Exit `2`. stdout JSON has `"decision":"deny"` and `reason` mentions the config could not be verified.
- **Proof.** Keep `config/print/stdout.txt` (valid file) and `config/invalid-hook/stdout.txt` (deny). Restore a valid file before driving other features in the same run, or cleanup and launch again.

There is no `llm-budget config set` command. Editing the file is the user write path. Drive that by writing the isolated file, then printing it.

## Gotchas

- `status` falls back to defaults with a warning when the file is invalid. A hook on an enforce event denies instead. Proving only status does not prove fail-closed config.
- `llm-budget config` and `llm-budget cursor config` currently print the same shared file. If they ever diverge, this recipe is wrong.
- `blockAtPercent: null` is monitor-only. Assert the printed JSONC, not a remembered default from README.
- Whitespace-only `config.jsonc` is treated as an empty object and filled with defaults. That is not the invalid-file path.
