# llm-budget verification map

This directory is the maintained source for verifying user-facing llm-budget CLI behavior. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch with `verify-llm-budget launch` so the CLI runs as `node dist/llm/cli.js` from this checkout.
- Isolated HOME is `/tmp/llm-budget-verify-*`. Doctor must print `doctor: ok`.
- `CLAUDE_HOME`, `CODEX_HOME`, `CURSOR_ACCESS_TOKEN`, and `GROK_HOME` are unset by the helper. Do not export them for a "more realistic" run.
- Never drive an `llm-budget` binary from PATH.
- Never run `llm-budget watchdog`.
- Isolated HOME has no Claude / Codex / Cursor / Grok login files. Usage lines will be unknown, unavailable, or (Grok) armed-and-blocking on unavailable usage. That is the default fixture.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise.
- Treat every command as literal. Keep quoted ids and flags unchanged.
- Run CLI actions through `verify-llm-budget cli -- …` or `verify-llm-budget hook …`.
- After a mutation, read status or the written file. Do not trust install stdout alone.
- Restore nothing to the real user home. Cleanup deletes only the isolated home.

## Proof and skip reporting

- Capture the command (`cmd.txt`) plus stdout, stderr, and exit code.
- Mutation proof includes a second view: `status` after install, or `home-file` of the written JSON.
- Record the feature id and entry point in the capture stem.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path. `llm-budget install` does not prove `llm-budget claude install`.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-llm-budget` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Status](./status.md) covers the combined live view, Cursor-only status, and Grok-only status.
- [Install hooks](./install.md) covers registering and removing Claude Code, Codex, Cursor Agent, and Grok CLI hooks.
- [Config](./config.md) covers printing and rejecting the shared config.jsonc.
- [Override and exceptions](./escape-hatches.md) covers temporary bypass and per-session exceptions.
- [Fail-closed hooks](./fail-closed-hooks.md) covers hook stdin blocking when usage cannot be determined.
