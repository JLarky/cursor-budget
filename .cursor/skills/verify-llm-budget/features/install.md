# Install hooks

Install registers llm-budget into each agent's hook file so the next prompt or tool call is gated. Uninstall removes those entries. Install also writes the default shared config if it is missing.

## Sub-features

- `install-all` registers Claude Code, Codex, and Cursor Agent in one command.
- `install-claude` writes `~/.claude/settings.json` UserPromptSubmit and PreToolUse entries.
- `install-codex` writes `~/.codex/hooks.json` UserPromptSubmit and PreToolUse entries.
- `install-cursor` writes `~/.cursor/hooks.json` plus the `~/.cursor/hooks/llm-budget` wrapper.
- `install-status` then reports `Hooks: installed` per agent.
- `uninstall-claude` / `uninstall-codex` / `uninstall-cursor` remove the matching entries.

## How to get to it (user POV)

- Run `llm-budget install`.
- Run `llm-budget claude install` or `llm-budget claude uninstall`.
- Run `llm-budget codex install` or `llm-budget codex uninstall`.
- Run `llm-budget cursor install` or `llm-budget cursor uninstall`.
- Run `llm-budget cursor uninstall --purge-data` to also clear Cursor rows in the shared store.

## Driving it with verify-llm-budget

Preconditions:

- `verify-llm-budget doctor` prints `doctor: ok`.
- Isolated HOME has no `.claude/settings.json`, `.codex/hooks.json`, or `.cursor/hooks.json`.
- Confirm with `verify-llm-budget capture install/before-status -- status`. stdout contains `Hooks: not installed — run llm-budget claude install`, `Hooks: not installed — run llm-budget codex install`, and `Hooks: not installed — run llm-budget cursor install`.

- **Install all agents.** Run `verify-llm-budget capture install/all -- install`. Exit `0`. stdout contains `Installed llm-budget Claude Code hooks`, `Installed llm-budget Codex native hooks`, and `Installed llm-budget Cursor Agent hooks`. Each section prints a path under isolated HOME.
- **Config created.** Run `verify-llm-budget home-file .config/llm-budget/config.jsonc`. The file exists and contains `"failClosed": true`.
- **Claude settings.** Run `verify-llm-budget home-file .claude/settings.json`. JSON `hooks.UserPromptSubmit` and `hooks.PreToolUse` each include a command pointing at `claude-hook` under isolated HOME. PreToolUse has `"matcher": "*"`.
- **Codex hooks.** Run `verify-llm-budget home-file .codex/hooks.json`. JSON `hooks.UserPromptSubmit` and `hooks.PreToolUse` each include a command pointing at `codex-hook` under isolated HOME.
- **Cursor hooks.** Run `verify-llm-budget home-file .cursor/hooks.json`. Every registered event has a command containing `llm-budget` and `"failClosed": true`. Wrapper file `.cursor/hooks/llm-budget` exists and execs `cursor hook`.
- **Status after install.** Run `verify-llm-budget capture install/after-status -- status`. Exit `0`. Claude Code, Codex, and Cursor Agent each show `Hooks: installed`.
- **Claude-only uninstall.** Run `verify-llm-budget capture install/claude-uninstall -- claude uninstall`. Exit `0`. stdout contains `Removed llm-budget entries from` the isolated settings path. Combined status then shows Claude hooks not installed while Cursor remains installed.
- **Cursor uninstall.** Run `verify-llm-budget capture install/cursor-uninstall -- cursor uninstall`. Exit `0`. stdout contains `Removed llm-budget Cursor Agent hook entries and wrapper.` and `Kept Cursor Agent data in the shared store.`
- **Proof.** Run `verify-llm-budget snapshot-home install/home` after the install-all step (before uninstall). Evidence includes the three hook files and both wrappers. Keep `install/all/stdout.txt` and `install/after-status/stdout.txt`.

To prove a per-agent entry point, start from a fresh launch and run that install command only. Do not treat `llm-budget install` as coverage of `llm-budget claude install`.

## Gotchas

- `llm-budget install` without isolated HOME writes the user's real Claude, Codex, and Cursor hook files. Doctor exists so you do not do that.
- Codex install may spawn `codex app-server` for up to 5 seconds to set hook trust. If Codex is not installed, stdout still reports install and adds `Codex hook trust could not be established automatically`. That is success for this fixture.
- Uninstall of Claude leaves the wrapper file in place. Absence of settings entries is the proof, not absence of the wrapper.
- `cursor uninstall --purge-data` resets Cursor config keys and sqlite rows. It does not remove Claude or Codex config. Only use it when the recipe says so.
- Cursor `hooks.json` `failClosed: true` is Cursor's process-crash policy for this hook. It is not the same field as `enforcement.failClosed` in config.jsonc.
- Re-running install is idempotent. A second install still exits 0 and keeps one llm-budget entry per event. Assert counts if you need to prove merge behavior.
