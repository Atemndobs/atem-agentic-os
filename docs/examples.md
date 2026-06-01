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

## End-to-End Demo Flow (Next ATEM Product Share)
This demo runs the new `repos`, `adapter`, `snapshot-diff`, and `archive` flows in one scriptable sequence.

### 0) Setup
```bash
atem init
atem start "Demo: provider handoff and archive lifecycle" --type implementation --repo /path/to/repo
```
Assume task id returned is `TASK-001`.

### 1) Attach secondary repo context
```bash
atem repos TASK-001 add /path/to/repo
atem repos TASK-001 list
```
Expected: repo appears as `[ok] /path/to/repo`.

### 2) Provider A update + first snapshot
```bash
atem route TASK-001 --to claude-code --repo /path/to/repo
atem adapter claude-code update TASK-001 provider=claude-code status=active summary="Scaffolded demo flow"
atem adapter claude-code touched TASK-001 docs/commands.md docs/examples.md
atem adapter claude-code validation TASK-001 "npm test"
atem adapter claude-code log TASK-001 "Prepared first handoff checkpoint"
atem snapshot TASK-001 --repo /path/to/repo
```

### 3) Provider B update + second snapshot
```bash
atem route TASK-001 --to codex --repo /path/to/repo
atem adapter codex update TASK-001 provider=codex status=active summary="Completed docs + runnable scenario"
atem adapter codex decision TASK-001 "Use snapshot-diff as demo evidence"
atem adapter codex log TASK-001 "Captured second checkpoint"
atem snapshot TASK-001 --repo /path/to/repo
```

### 4) Show handoff delta evidence
```bash
atem snapshot-diff TASK-001
```
Expected highlights:
- Provider transition line similar to `claude-code → codex`
- Working-tree file delta summary
- Current summary A vs B

### 5) Archive lifecycle (safe preview, then execute)
```bash
atem archive --broken --dry-run
atem archive TASK-001
```
Expected:
- Dry run prints only candidates with missing repos.
- Direct archive moves `TASK-001` into `~/.atem/harness/sessions/_archive/TASK-001` and stamps `status: archived`.
