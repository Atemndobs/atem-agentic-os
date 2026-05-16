# Examples
## Follow one repository
`atem status --repo /path/to/repo`

## Start tracker task
`atem start "System-wide session control" --type tracker`

## Start implementation task
`atem start "Fix OAuth callback timeout" --type implementation --repo /path/to/repo`

## Route and handoff
`atem route TASK-001 --to codex --repo /path/to/repo`
`atem handoff TASK-001`

## Project workflow
`atem project init --repo /path/to/repo`
`atem worktree start TASK-123 --repo /path/to/repo --branch task/example`
`atem ready TASK-123 --repo /path/to/repo --pr https://github.com/org/repo/pull/123`
`atem integrate TASK-123 --repo /path/to/repo`
