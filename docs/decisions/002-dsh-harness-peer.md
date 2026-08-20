# ADR-002: DeepSeek Harness is a peer harness, not a dependency

> Date: 2026-08-20
> Status: Accepted
> Relates to: [ADR-001](001-atem-naming.md), [sub-plan-event-log-task-store](../sub-plan-event-log-task-store.md)

## Context

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) surfaced as a high-profile open-source project (tagline:
"Everything is a Plugin"). The question raised: do we need it, and
what can we learn from it.

We assessed the repo README and architecture doc (not a runtime
install, so the claims below are as-documented, not as-verified).

**What dsh is.** A full coding-agent *harness*: it runs the agent loop,
talks to a model, calls tools, enforces sandbox and approval policy,
and streams results. Same category as Claude Code, Codex, Cursor, and
OpenCode. It is built on the Cordis plugin framework, where the model
adapter, tool registry, session log, and even the agent loop are
plugins composed at boot from ordered layers (profiles, bundles,
patches). Its source of truth is an append-only `SessionEvent` log; the
model's context, transcripts, fork, and resume are all *derived* from
that stream.

**What ATEM is.** The opposite layer. ATEM does not execute work (see
ADR-001, the "E" is Execution *inside external providers*). It is the
continuity mesh that coordinates handoffs *between* harnesses.

The two do not overlap. dsh is precisely the kind of provider that
sits *inside* ATEM's provider matrix, beside Codex and Cursor.

## Decision

1. **Do not adopt dsh as a dependency and do not replace any part of
   ATEM's core with it.** It operates one layer below us and fills no
   gap in a system that deliberately has no agent loop.

2. **Treat dsh as a future handoff target, not now.** If it gains
   adoption it becomes one more adapter + launcher (detect session,
   write `AGENTS.md`, launch). It already ships an `AGENTS.md`
   convention and an `.agents/` directory, so the adapter would be
   cheap. Gate this on observed local usage, not on the star count.

3. **Backlog two architectural learnings** (below). Steal the patterns,
   not the framework. We are not adopting Cordis.

## The two learnings

### L1 (high value): append-only event log for the task store

ATEM stores task state as seven whole-file markdown artifacts
(`brief`, `state`, `handoff`, `next`, `decisions`, `validation`,
`log`), each overwritten in place by `fs.writeFileSync`
(`src/materialize.js`), plus periodic snapshots.

That overwrite model is *why* the recovery subsystem exists. Every
detector in `src/recovery.js` (missing files, corrupted frontmatter,
stale progress, duplicate provider blocks) is a symptom of state that
was clobbered or drifted between provider surfaces. `reconcile`,
`rollback`, and `snapshot-diff` are all machinery to fight that drift.

dsh's model (one append-only event stream, every other view derived
from it) makes provenance, replay, and reconciliation almost free.
Adopting an event-log backbone under ATEM's task store would collapse
most of the recovery subsystem into a derived projection and make
cross-provider reconciliation deterministic instead of heuristic. See
[sub-plan-event-log-task-store](../sub-plan-event-log-task-store.md).

### L2 (medium value): formalize adapters/launchers as a patch layer

`src/adapters/*` and `src/launchers/*` are already plugin-shaped but
are wired through hardcoded `index.js` dispatchers. dsh's
profiles/bundles/patches model (drop-in config rows, `--dump-config`
transparency) is the mature version of the same idea. Worth adopting
the *pattern* so a new provider is a registered row rather than an edit
to a dispatcher. Lower priority than L1.

## What we explicitly do not copy

dsh's sandbox and approval seam governs *executing* work. ATEM executes
nothing, so that seam has no analog here.

## Consequences

- No code change now. Two backlog items (L1, L2) with L1 specced in a
  sub-plan.
- A `dsh` adapter is a known future option, deferred until there is
  real local usage to hand off to.
- The assessment is README/architecture-doc based; a runtime install
  would be needed before committing to a `dsh` adapter.
