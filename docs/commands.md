# Commands
## Global Session Commands
- `atem status [--repo <repo>]`
- `atem init`
- `atem start "<task>" [--type <type>] [--repo <repo>]`
- `atem adopt <task-id>`
- `atem route <task-id> --to <provider> [--repo <repo>]`
- `atem handoff <task-id> [--to <provider>] [--repo <repo>]`
- `atem snapshot <task-id> [--repo <repo>]`
- `atem doctor`
- `atem clean <task-id>`
- `atem open <task-id> [--file <name>]`
- `atem note <task-id> "<note>" [--decision ...] [--next ...] [--validation ...]`
- `atem instructions <provider>`

## Project/Worktree Commands
- `atem project init --repo <repo> [--convex]`
- `atem project instructions --repo <repo>`
- `atem project doctor --repo <repo>`
- `atem worktree start <task-id> --repo <repo> --branch <branch> [--path <path>]`
- `atem ready <task-id> --repo <repo> [--pr <url>]`
- `atem integrate <task-id> --repo <repo>`
