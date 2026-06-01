# ATEM
Session handoff for AI coding agents, backed by Git.
ATEM is a local-first session handoff layer for AI coding agents. It lets Claude Code, Codex, Cursor, OpenCode, OpenRouter, local models, and human sessions hand off coding work without losing context.
It does not replace your IDE or your coding agents. It gives them a shared file-based protocol for continuing work safely.

## Naming Note
The CLI may still be invoked as `atem` during the transition.
The product name is ATEM.
Existing state remains stored under:
`~/.atem/harness/`
Future versions may add a `atem` command alias and migrate state to `~/.atem/`.

## Core Commands
- `atem status [--repo <repo>]`
- `atem start "<task>" --type <type> --repo <repo>`
- `atem adopt <task-id>`
- `atem route <task-id> --to <provider> [--repo <repo>]`
- `atem handoff <task-id> [--to <provider>] [--repo <repo>]`
- `atem snapshot <task-id> [--repo <repo>]`
- `atem snapshot-diff <task-id> [<snap-a> <snap-b>]`
- `atem repos <task-id> <list|add> [path]`
- `atem adapter <provider> <read|update|log|decision|validation|touched> <task-id> [...]`
- `atem archive <task-id>`
- `atem archive --broken [--dry-run]`
- `atem doctor`
- `atem clean <task-id>`

`atem status --repo <repo>` scopes detected provider activity to that repository path.

## Project/Worktree Commands
- `atem project init --repo <repo> [--convex]`
- `atem project instructions --repo <repo>`
- `atem project doctor --repo <repo>`
- `atem worktree start <task-id> --repo <repo> --branch <branch> [--path <path>]`
- `atem ready <task-id> --repo <repo> [--pr <url>]`
- `atem integrate <task-id> --repo <repo>`

## Docs
- `docs/commands.md`: command reference
- `docs/examples.md`: runnable examples including demo flow
- `docs/provider-contract.md`: provider-neutral workflow contract
