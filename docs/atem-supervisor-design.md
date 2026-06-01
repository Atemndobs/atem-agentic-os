# ATEM Global Supervisor Design (`atem monitor`)

## Goal
Create a streamlined, machine-wide ATEM process that continuously checks ongoing coding work and keeps task tracking aligned with real provider activity (especially Claude Code worktrees), without manual status polling.

## Problem
Current ATEM commands are operator-driven (`status`, `adopt`, `doctor`, `route`).
When multiple worktrees are active across repos, drift happens:
- active coding sessions with no ATEM task
- ATEM tasks with stale/incorrect provider or repo context
- tracker tasks left active while real implementation is happening elsewhere

## Proposed Solution
Add a new command group:
- `atem monitor run` (one-shot audit)
- `atem monitor start` (background daemon)
- `atem monitor stop`
- `atem monitor status`
- `atem monitor report [--last N]`

The monitor continuously:
1. scans provider activity globally (reuse existing detection logic from `status`)
2. correlates active workspaces/worktrees to ATEM sessions
3. writes machine-readable findings
4. optionally creates actionable follow-up entries

No code edits are performed by the monitor itself.

## Scope
### In scope
- Global machine monitoring for provider/task drift
- JNA project follow-up orchestration
- Durable reports and queueing
- Background lifecycle management

### Out of scope
- Auto-merging branches
- Auto-running tests/deploy
- Mutating repo code/files outside ATEM state

## Command UX
### One-shot audit
```bash
atem monitor run
```
Outputs summary + writes detailed report.

### Start daemon
```bash
atem monitor start --interval 120
```
Runs every 120 seconds until stopped.

### Check daemon health
```bash
atem monitor status
```
Shows:
- running/paused
- pid
- interval
- last run timestamp
- findings count by severity

### Stop daemon
```bash
atem monitor stop
```

### Historical report view
```bash
atem monitor report --last 10
```

## Data Model
Store under global ATEM state:
`~/.atem/harness/monitor/`

Files:
- `state.json` (daemon status, pid, interval, last_run)
- `history.ndjson` (append-only run summaries)
- `reports/<timestamp>.json` (full per-run findings)
- `followups.md` (human-readable action queue)
- `repo-map.json` (optional watched repos / naming rules)

## Finding Types
Each finding includes:
- `id`
- `severity` (`info`, `warn`, `critical`)
- `type`
- `provider`
- `repo`
- `workspace`
- `task_id` (if matched)
- `message`
- `suggested_action`

Core finding types:
1. `untracked_active_workspace`
2. `task_repo_mismatch`
3. `task_provider_mismatch`
4. `stale_active_task`
5. `multiple_tasks_same_workspace`
6. `dirty_worktree_no_task`
7. `active_tracker_with_code_activity`

## Matching Logic
Priority order:
1. exact match on `target_repo`
2. match by `Related Workspaces` section
3. fallback to path-prefix match

If no match:
- create `untracked_active_workspace` finding
- include suggested `atem start` command template

## JNA Workflow Policy (Initial)
Target repos:
- `apps-ja/opscentral-admin`
- `apps-ja/jna-cleaners-app`
- `apps-ja/ops-tasks` (if active)

Rules:
1. Any active Claude worktree in these repos must map to an active `implementation` task.
2. `tracker` tasks in these repos are warning-level unless explicitly flagged `state-only`.
3. Dirty worktree + no mapped task is critical.

## Follow-up Queue Behavior
On each run:
- regenerate `followups.md` top section with open items
- preserve completed items below marker
- include copy/paste commands per item

Example follow-up item:
- Create task for workspace `.../worktrees/quirky-*`
  - `atem start "Opscentral: <goal>" --type implementation --repo /.../opscentral-admin`
  - `atem route TASK-XXX --to claude-code --repo /.../opscentral-admin`

## Background Execution Model
Implementation approach (v1):
- `atem monitor start` launches detached Node process running monitor loop
- pid tracked in `monitor/state.json`
- lock file prevents duplicate daemons
- `stop` sends SIGTERM and verifies shutdown

Safety:
- no shelling into repos except read-only git inspection
- no ATEM task mutation unless user passes `--auto-fix` (future phase)

## Integration Reuse
Reuse existing internals from `src/cli.js`:
- provider detection functions used by `status`
- session file parsing/frontmatter helpers
- `requireSession` / path resolution utilities

Avoid duplicating parsing logic.

## Rollout Plan
### Phase 1 (fast)
- `atem monitor run`
- report generation + followups queue
- no daemon

### Phase 2
- `start/stop/status`
- interval loop + history storage

### Phase 3
- optional `--auto-fix` for low-risk ATEM metadata repairs only
  - e.g., stale provider field updates
  - never starts tasks automatically without explicit flag

## Success Criteria
1. Every active Claude Code JNA worktree appears in monitor report.
2. Untracked workspaces produce actionable commands.
3. Operator can run one command (`atem monitor status`) to know whether tracking is healthy.
4. No codebase modifications occur from monitor runs.

## Immediate Next Step
Implement Phase 1 first (`atem monitor run`) and validate against current JNA active worktrees before enabling daemon mode.
