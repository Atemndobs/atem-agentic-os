---
name: atem-handoff
description: |
  Hand off the current coding session to another AI provider (Codex,
  Cursor, OpenCode, omp). Use this when the user says "hand this off",
  "give this to <provider>", "let <provider> continue", or any
  cross-provider continuity request. The handoff preserves the
  current task, the bigger project plan (purpose + sub-plans + research
  + decisions), and writes AGENTS.md into the target repo so the next
  provider auto-discovers the contract on session start.
triggers:
  - "hand this off"
  - "hand off to *"
  - "give this task to *"
  - "let codex continue"
  - "switch to cursor"
  - "atem handoff"
---

# ATEM handoff

This skill drives ATEM's provider-agnostic session-handoff layer.

## When to use this

- The user wants to move the current work to a different AI provider.
- The user wants to resume an idle session in a different tool.
- The user is closing out and wants the next agent (whoever they pick)
  to have full context.

## How to invoke

**Prefer the MCP tool** when available. The `atem` MCP server registers
`atem_handoff`, `atem_status`, `atem_resolve`, `atem_adopt`, and
`atem_ingest_omp` automatically once `atem install` has been run.

```
atem_handoff({
  task: "<ATEM task id, e.g. claude-code:<session-uuid> or TASK-001>",
  to:   "<provider>",                     // codex | cursor | omp | …
  repo: "<absolute repo or worktree path>" // optional; defaults from session
})
```

If the MCP tool is not present, fall back to a Bash invocation:

```sh
atem handoff <task-id> --to <provider> --repo <path>
```

## Discovering the current task id

If you're inside a Claude Code session and the user wants to hand off
the *current* session, the synthetic ATEM id is
`claude-code:<sessionId>`. Read it from:

```
~/.claude/sessions/<pid>.json   →   { "sessionId": "..." }
```

Or just call `atem_status({ repo: process.cwd() })` and pick the live
`claude-code:*` row.

## Behavior to expect

The handoff:

1. Materializes the synthetic task into `~/.atem/harness/sessions/<id>/`
   if it's not already there.
2. Distills the conversation into `brief.md`, `state.md`,
   `handoff.md`, `next.md`, `decisions.md`, `log.md`, `validation.md`.
3. Bundles **project context** (`docs/action-plan.md`,
   `docs/sub-plan-*.md`, `docs/research/*.md`, `ADR/*` …) into the
   handoff prompt.
4. Writes `AGENTS.md` at the target repo so the destination provider
   auto-loads the contract.
5. Calls the destination provider's launcher (Codex JSON-RPC bridge,
   `claude --resume`, `cursor <path>`, etc.).
6. Returns the deep link / sidebar entry / confirmation.

## What to tell the user

After invoking, summarize succinctly:

- Which task id was handed off.
- Which provider got it.
- How to find the new session (sidebar entry, deep link, or shell).
- The handoff command they can rerun later.

Don't dump the full prompt unless they ask — it's already loaded as the
new session's first turn and `developerInstructions`.
