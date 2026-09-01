# Override and exceptions

Override temporarily bypasses gates for a duration. Exceptions exempt one session id forever until removed. Claude Code and Codex share one override/exception store. Cursor Agent has its own. Grok CLI has its own. Unblocking one agent does not unblock the others.

## Sub-features

- `override-on` activates a Claude/Codex override from a duration like `15m`, `30m`, `1h`.
- `override-off` clears that override.
- `override-cursor-on` / `override-cursor-off` do the same for Cursor Agent.
- `override-grok-on` / `override-grok-off` do the same for Grok CLI.
- `except-add-list-remove` adds, lists, and removes a Claude/Codex session id.
- `except-cursor-add-list-remove` does the same for a Cursor conversation id.
- `except-grok-add-list-remove` does the same for a Grok session id.
- `override-status` shows `Override: until …` or `Override: none` in the matching status block.

## How to get to it (user POV)

- Run `llm-budget override <duration>` or `llm-budget override off`.
- Run `llm-budget except add <session-id>`, `except remove <session-id>`, `except list`.
- Run `llm-budget cursor override <duration>` or `llm-budget cursor override off`.
- Run `llm-budget cursor except add <session-id>`, `except remove <session-id>`, `except list`.
- Run `llm-budget grok override <duration>` or `llm-budget grok override off`.
- Run `llm-budget grok except add <session-id>`, `except remove <session-id>`, `except list`.

Block messages also print these recover commands, which is how a blocked user finds them.

## Driving it with verify-llm-budget

Preconditions:

- `verify-llm-budget doctor` prints `doctor: ok`.
- No override is active. `except list`, `cursor except list`, and `grok except list` print `No session exceptions.`

- **Claude/Codex override on.** Run `verify-llm-budget capture escape/override-on -- override 15m`. Exit `0`. stdout matches `Override active until ` plus a locale timestamp.
- **Visible in combined status.** Run `verify-llm-budget capture escape/status-after-override -- status`. The Claude Code block and the Codex block contain `Override: until`. The Cursor Agent and Grok CLI blocks still contain `Override: none`.
- **Claude/Codex override off.** Run `verify-llm-budget capture escape/override-off -- override off`. Exit `0`. stdout is `Override cleared. Limits will be enforced again.` Combined status then shows `Override: none` in the Claude and Codex blocks.
- **Cursor override on.** Run `verify-llm-budget capture escape/cursor-override-on -- cursor override 15m`. Exit `0`. stdout matches `Override active until ` and `Events are still recorded.` Combined status Cursor block contains `Override: until`.
- **Cursor override off.** Run `verify-llm-budget capture escape/cursor-override-off -- cursor override off`. Exit `0`. stdout is `Override cleared. Limits will be enforced again.`
- **Grok override on.** Run `verify-llm-budget capture escape/grok-override-on -- grok override 15m`. Exit `0`. stdout matches `Override active until ` plus a locale timestamp. Combined status Grok CLI block contains `Override: until`.
- **Grok override off.** Run `verify-llm-budget capture escape/grok-override-off -- grok override off`. Exit `0`. stdout is `Override cleared. Limits will be enforced again.`
- **Except add.** Run `verify-llm-budget capture escape/except-add -- except add verify-sess-1`. Exit `0`. stdout contains `Excepted verify-sess-1.` and `Session exceptions (1):` with `verify-sess-1`. `verify-llm-budget cli -- except list` prints the same id.
- **Except remove.** Run `verify-llm-budget capture escape/except-remove -- except remove verify-sess-1`. Exit `0`. stdout contains `Removed exception for verify-sess-1.` List then prints `No session exceptions.`
- **Cursor except add.** Run `verify-llm-budget capture escape/cursor-except-add -- cursor except add verify-conv-1`. Exit `0`. stdout contains `Excepted verify-conv-1.` and says it will not count toward the event-rate backstop.
- **Cursor except remove.** Run `verify-llm-budget capture escape/cursor-except-remove -- cursor except remove verify-conv-1`. Exit `0`. stdout contains `Removed exception for`.
- **Grok except add.** Run `verify-llm-budget capture escape/grok-except-add -- grok except add verify-sess-1`. Exit `0`. stdout contains `Excepted verify-sess-1. It will bypass the Grok gate.` and `Session exceptions (1):` with `verify-sess-1`.
- **Grok except remove.** Run `verify-llm-budget capture escape/grok-except-remove -- grok except remove verify-sess-1`. Exit `0`. stdout contains `Removed exception for verify-sess-1.` List then prints `No session exceptions.`
- **Stores stay separate.** After adding only `verify-sess-1` via `except add`, `cursor except list` and `grok except list` still print `No session exceptions.` After adding only `verify-conv-1` via `cursor except add`, `except list` and `grok except list` still print `No session exceptions.`
- **Proof.** Keep `escape/status-after-override/stdout.txt` (Claude/Codex until, Cursor/Grok none) and `escape/except-add/stdout.txt`. Confirm the exception is in isolated `config.jsonc` via `home-file .config/llm-budget/config.jsonc`.

## Gotchas

- Durations must look like `15m`, `30m`, `1h`, or `Nd`. `override 15` exits 1 with a usage error.
- `llm-budget override` does not clear a Cursor or Grok override. `llm-budget cursor override off` and `llm-budget grok override off` each clear only their own store.
- Exceptions are written into config.jsonc (`excludeSessionIds` vs `cursor.excludeConversationIds` vs `grok.excludeSessionIds`). Listing via CLI is the user view. The file is the persistence proof.
- An expired override must display as `none`, not as `until` in the past. Proving that requires a clock change or sqlite write, which this map does not treat as a user path. Skip rather than poke the db.
- Overrides and exceptions bypass gates even when failClosed is on. Pair this feature with `fail-closed-hooks` if you need to prove a blocked hook starts allowing after `override 30m`.
