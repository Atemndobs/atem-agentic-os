# Sub-plan: append-only event log under the task store

> Date: 2026-08-20
> Status: Draft (backlog)
> Origin: [ADR-002](decisions/002-dsh-harness-peer.md) learning L1
> Learned from: DeepSeek Harness `SessionEvent` log + `deriveMessages()`

## Problem

Task state today is seven whole-file markdown artifacts overwritten in
place (`src/materialize.js`), plus snapshots. Overwrites lose history,
let concurrent provider surfaces clobber each other, and force the
whole `src/recovery.js` subsystem to detect and repair drift after the
fact. There is no single ordered record of "what actually happened to
this task."

## Idea

Make an **append-only event log the source of truth per task**, and
make the seven markdown artifacts **derived projections** of that log.
Nothing appends over anything; every write is a new event. State files
become a rendered view, regenerated from the log, never authored
directly.

This is the dsh pattern (one durable stream, everything else derived)
applied to ATEM's file-backed, provider-agnostic world.

## Shape on disk

```
~/.atem/harness/sessions/TASK-001/
├── events.ndjson          # append-only log, one JSON event per line (source of truth)
├── brief.md               # derived projection (rendered, never hand-authored)
├── state.md               # derived projection
├── handoff.md  next.md  decisions.md  validation.md  log.md   # derived
└── snapshots/             # unchanged; now a cheap log-offset marker
```

Backward compatible: the `.md` files keep the exact names and format
providers already read. Only their *authorship* changes (rendered, not
overwritten by hand).

## Event vocabulary (starting set)

Each line: `{ ts, actor, provider, type, payload }`.

| type | emitted when | projects into |
| --- | --- | --- |
| `task/created` | `atem start` / adopt / materialize | brief.md |
| `state/updated` | provider reports progress | state.md |
| `decision/recorded` | a decision is captured | decisions.md |
| `handoff/prepared` | `atem handoff` builds a prompt | handoff.md |
| `handoff/received` | destination provider picks up | log.md, state.md |
| `validation/added` | a check passes/fails | validation.md |
| `next/set` | next steps change | next.md |
| `snapshot/marked` | `atem snapshot` | snapshots/ + offset |
| `task/closed` | `atem close` | state.md status |

`actor` + `provider` on every event is what makes cross-provider
reconciliation deterministic: you can see exactly which surface wrote
what, in order.

## Projection

A single `deriveArtifacts(events) -> { brief, state, ... }` folds the
log into the seven rendered files (mirror of dsh's `deriveMessages()`).
Pure function, no I/O, trivially testable: feed a log, assert the
markdown. Rendering runs after every append and on demand
(`atem clean` becomes "re-derive from log").

## What this collapses

| Today (overwrite world) | Event-log world |
| --- | --- |
| `detectCorruptedFrontmatter` | frontmatter is rendered, cannot corrupt |
| `detectDuplicateProviderBlocks` | ordering is inherent in the log |
| `rollback` to a snapshot | truncate/replay the log to an offset |
| `reconcile --unify <provider>` | fold events, last-writer or actor-aware merge |
| `snapshot-diff` | diff two log offsets |

`recover` shrinks to "is the log readable and does it re-derive?"

## Migration path (incremental, no big bang)

1. **Dual-write.** Every existing state write also appends an event.
   `.md` files still authoritative. Zero behavior change, log
   accumulates. Validate `deriveArtifacts(log)` matches the live files.
2. **Flip authority.** State writes go to the log only; `.md` files
   re-rendered from it. Recovery detectors kept but expected to go
   quiet.
3. **Retire drift machinery.** Replace rollback/reconcile/snapshot-diff
   internals with log operations; keep the CLI surface identical.

Each step ships independently and is reversible (delete `events.ndjson`
to fall back to phase 0).

## Open questions

- Concurrent appends from two live providers: file lock, or
  append-and-let-order-decide? (ndjson append is atomic per line on
  local fs; likely fine.)
- Log compaction for long-lived tasks, or leave unbounded and let
  snapshots mark offsets?
- Do human edits to a rendered `.md` become a `state/updated` event on
  next scan, or are hand-edits disallowed once authority flips?

## Non-goals

- Not adopting Cordis or any plugin framework.
- Not changing the seven artifact names/formats providers consume.
- Not touching execution; ATEM still executes nothing.
