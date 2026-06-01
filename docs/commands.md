# Commands
## Global Session Commands
- `atem status [--repo <repo>]`
- `atem init`
- `atem start "<task>" [--type <type>] [--repo <repo>]`
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
- `atem open <task-id> [--file <name>]`
- `atem note <task-id> "<note>" [--decision ...] [--next ...] [--validation ...]`
- `atem instructions <provider>`
- `atem goals [--repo <repo>] [--files <a,b,c>] [--json]`

## New Flow Commands
### `snapshot-diff`
- Usage: `atem snapshot-diff <task-id> [<snap-a> <snap-b>]`
- Compares two snapshots for provider/status transitions and working-tree file deltas.
- Defaults to the latest two snapshots when explicit snapshot names are omitted.
- Requires at least 2 snapshots for the task.

### `repos`
- Usage: `atem repos <task-id> <list|add> [path]`
- `list` shows tracked repos with existence check: `[ok]` or `[MISSING]`.
- `add` appends a repo path to the task's repository list.

### `adapter`
- Usage: `atem adapter <provider> <read|update|log|decision|validation|touched> <task-id> [...]`
- Provider-facing session API for automation and tool adapters.
- `read`: print normalized task session JSON.
- `update`: patch session metadata using `key=value` args.
- `log`: append provider log entry.
- `decision`: append decision record.
- `validation`: append validation command record (pending by default).
- `touched`: append touched file paths.

### `archive`
- Usage: `atem archive <task-id>`
- Usage: `atem archive --broken [--dry-run]`
- Moves a session into `sessions/_archive/<task-id>` and stamps `status: archived`.
- `--broken` archives tasks whose target repo path no longer exists.
- `--dry-run` prints candidates without moving anything.

## Project/Worktree Commands
- `atem project init --repo <repo> [--convex]`
- `atem project instructions --repo <repo>`
- `atem project doctor --repo <repo>`
- `atem worktree start <task-id> --repo <repo> --branch <branch> [--path <path>]`
- `atem ready <task-id> --repo <repo> [--pr <url>]`
- `atem integrate <task-id> --repo <repo>`
