<!-- atem:agents:begin -->
# ATEM Session Contract

This repository is participating in an ATEM session-handoff workflow.
Active task: `claude-code:1bdfa3c6-d0ab-478e-abee-b7c8deddc952` (type: `implementation`), current provider: `codex`.

## Before doing anything

Read the active session files. Prefer the stable URL form — same path
regardless of harness mode or future layout changes:

- `atem://current/brief` — what this task is
- `atem://current/state` — current state
- `atem://current/handoff` — what the previous provider left for you
- `atem://current/next` — what to do next
- `atem://current/decisions` — past decisions you must respect

Dereference from a shell with `atem resolve <url>`. Same files are
symlinked under `~/.atem/handles/current/*.md` for providers whose
tools only accept literal local paths.

Concrete paths for this harness (snapshot):
- `../../.atem/harness/sessions/claude-code:1bdfa3c6-d0ab-478e-abee-b7c8deddc952/brief.md`
- `../../.atem/harness/sessions/claude-code:1bdfa3c6-d0ab-478e-abee-b7c8deddc952/state.md`
- `../../.atem/harness/sessions/claude-code:1bdfa3c6-d0ab-478e-abee-b7c8deddc952/handoff.md`
- `../../.atem/harness/sessions/claude-code:1bdfa3c6-d0ab-478e-abee-b7c8deddc952/next.md`
- `../../.atem/harness/sessions/claude-code:1bdfa3c6-d0ab-478e-abee-b7c8deddc952/decisions.md`

## Repository boundary

Only modify files inside `/Users/atem/sites/atem-agentic-os`. Never touch sibling repos or sibling worktrees.

## Before stopping

Update the session files (`handoff.md`, `state.md`, `next.md`, `log.md`, and `decisions.md` when relevant).
Never end without updating `handoff.md`.

Managed by ATEM. Edit content above/below this block, but leave this block intact — `atem handoff` regenerates it.
<!-- atem:agents:end -->
