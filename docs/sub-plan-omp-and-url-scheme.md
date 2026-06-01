# Sub-Plan: omp Provider Integration → `atem://` URL Scheme

> Parent: `docs/action-plan.md` — Workstream 3 (Provider Adapter Layer)
> Status: Drafted 2026-06-01
> Ordering: Phase 1 ships first, Phase 2 builds on top.

---

## Why this plan exists

We want to ride omp's roadmap as free leverage instead of reimplementing its mechanisms (stream rules, hashline edits, rule-file readers). The only sustainable boundary between ATEM and omp is the **provider interface** — omp ships an agent; ATEM coordinates between agents.

So:

- **Phase 1** adds omp as a first-class provider in ATEM. Every omp release benefits ATEM users automatically because they run omp directly.
- **Phase 2** introduces the `atem://` URL scheme so any provider (omp, Claude Code, Codex, Cursor) reaches session state through one stable interface. This is the structural payoff that makes Workstream 3 N+1 providers free instead of N+1 adapters.

Each phase is independently shippable. Phase 1 has user-visible value on day one; Phase 2 is the architectural upgrade that follows.

---

## Phase 1 — omp as a first-class provider

### Goal

Running `omp` in a repo is automatically visible to ATEM. Handoffs to and from omp work the same as Claude Code and Codex today.

### Out of scope

- Importing any omp code.
- Modifying omp's behavior.
- Stream rules, hashline edits — those stay inside omp's runtime.

### Tasks

**T1.1 — Discover omp's on-disk layout (research only)**
- Locate omp's session directory (likely `~/.omp/sessions/` or similar).
- Document the session file format (JSON / SQLite / markdown — TBD).
- Document how to identify the active repo for a session (cwd capture).
- Document how omp picks up rule files (CLAUDE.md, AGENTS.md, `.cursorrules`, MDC).
- Output: `docs/research/omp-session-layout.md`. No code.

**T1.2 — Provider detection**
- Extend `atem status` to detect a running `omp` process.
- Identify session ID + cwd per process.
- Add `omp` to the list of known providers everywhere it's referenced.

**T1.3 — omp session reader**
- New module: `src/adapters/omp.ts`.
- Read omp's session file for a given session ID.
- Extract: cwd, current todos/plan, last N tool calls, model in use, last user prompt.
- Pure read — no writes to omp's files. Their format is theirs.

**T1.4 — Register omp in the adapter registry**
- Add `omp` adapter alongside `claude-code`, `codex`, `cursor`, `opencode`.
- Implements the same interface the registry already defines.

**T1.5 — Handoff TO omp**
- Generate an `AGENTS.md` (omp's preferred rule format) in the target repo or worktree.
- Content: task brief, task-type rules, repo boundary, pointer to ATEM session files.
- Verify omp picks it up on next launch.

**T1.6 — Handoff FROM omp**
- When the user runs `atem snapshot TASK-XXX` while omp is the active provider, distill omp's session state into ATEM's `state.md`, `next.md`, `decisions.md`.
- Map omp todos → ATEM `next.md`.
- Map omp's last assistant turn → ATEM `state.md` ("last action").

**T1.7 — End-to-end loop test**
- `omp` running in `repo-a` → `atem status` shows it → `atem adopt TASK-OMP-1` creates a session → `atem handoff TASK-OMP-1 --to codex` produces a prompt with omp's actual context (todos, last action, decisions) embedded.

**T1.8 — Doctor integration**
- `atem doctor` validates omp sessions: detects orphaned references, missing AGENTS.md when an omp handoff is queued, etc.

### Success criteria

- `omp` is a fully supported provider in `atem status`, `atem adopt`, `atem handoff`, `atem snapshot`, `atem doctor`.
- A full provider loop (Claude Code → omp → Codex) preserves task intent and repo boundaries.
- Zero omp source code imported. Their next release does not break our adapter.

---

## Phase 2 — `atem://` URL scheme

### Goal

Every provider — including ones we haven't written adapters for yet — can reach session state through one path convention. Adding a new provider becomes: "point its existing `read` tool at `atem://current/handoff`."

### Why now (after Phase 1)

Phase 1 forces us to write the same path-resolution logic in the omp adapter that we already wrote for Claude Code and Codex. Phase 2 generalizes that logic into one resolver so the *next* provider needs zero per-path code.

### Tasks

**T2.1 — Grammar specification**
- Document the scheme in `docs/url-scheme.md`. Examples:
  - `atem://TASK-001/state` → `state.md`
  - `atem://TASK-001/handoff` → `handoff.md`
  - `atem://TASK-001/snapshots/3` → `snapshots/3/`
  - `atem://TASK-001/decisions` → `decisions.md`
  - `atem://current` → resolves to the active session for cwd
  - `atem://current/handoff` → composition
  - `atem://list` → JSON index of all sessions
- Specify resolution rules for `current` (cwd → repo → active session).
- Specify error cases (no active session, ambiguous repo, missing file).

**T2.2 — Resolver implementation**
- New module: `src/url.ts`.
- `resolveAtemUrl(url, ctx) → { localPath, mimeType, metadata }`.
- Pure function. No side effects.
- Unit tests for every example in the grammar.

**T2.3 — `atem resolve` CLI command**
- `atem resolve atem://current/handoff` → prints absolute local path.
- Lets any shell or rule file dereference URLs: `cat $(atem resolve atem://current/handoff)`.
- Exit code signals resolution success/failure.

**T2.4 — Handle materialization (symlink farm)**
- ATEM maintains `~/.atem/handles/<session-id>/{state.md, handoff.md, ...}` as symlinks to the canonical session files.
- `~/.atem/handles/current` is a symlink to the active session, updated on `atem route` / `atem adopt`.
- This is the fallback for providers that can't be taught about URL schemes — their `read` tool sees a normal file.

**T2.5 — Rule-file generators reference URLs**
- Update `atem instructions <provider>` output (CLAUDE.md, AGENTS.md, `.cursorrules`) to reference `atem://current/*` and explain the convention.
- Include the `atem resolve` fallback for shells.

**T2.6 — Adapter registry exposes URL accessor**
- Adapter interface gains: `read(url) → content`, `write(url, content, expectedHash?) → result`.
- Each adapter (Claude Code, Codex, Cursor, omp) delegates to the central resolver.
- Per-adapter code shrinks. New provider = one stub that registers itself.

**T2.7 — Hash-anchored writes (opportunistic upgrade)**
- The `write(url, content, expectedHash)` signature opens the door to omp-style stale-anchor rejection on session files.
- If `expectedHash` is provided and the file's current hash differs, reject. This is the integrity mechanism we discussed; cheap to add once the URL scheme is the only write path.

**T2.8 — Doctor checks**
- Validate `~/.atem/handles/` symlinks point at real files.
- Validate `current` resolves where expected.
- Detect orphan handles after `atem clean`.

### Success criteria

- A provider with only `read` and `write` filesystem tools can fully participate in ATEM via `atem://current/*` paths plus a symlinked materialization dir.
- All existing adapters (Claude Code, Codex, Cursor, omp) route reads/writes through the resolver.
- `atem instructions` output references the URL scheme instead of hardcoded session paths.
- Doctor catches broken symlinks.

---

## Execution order and dependencies

```
Phase 1
  T1.1 (research) → T1.2 (detection)
                  ↘ T1.3 (reader) → T1.4 (registry) → T1.5 (handoff TO)
                                                    ↘ T1.6 (handoff FROM) → T1.7 (E2E) → T1.8 (doctor)

Phase 2
  T2.1 (grammar) → T2.2 (resolver) → T2.3 (CLI) → T2.4 (symlinks) → T2.5 (rule files)
                                  ↘ T2.6 (adapter interface) → T2.7 (hashes) → T2.8 (doctor)
```

T1.1 is research-only and gates everything else in Phase 1. T2.1 is spec-only and gates Phase 2.

---

## What this defers (explicitly)

- Ambient sessions / auto-task-creation (discussed but separate plan; should follow Phase 2 since it leans on `atem://current` resolution).
- Stream-rule enforcement at the adapter layer (separate, builds on Phase 1's adapter contract).
- Multi-provider concurrent writes / merge logic (separate; T2.7 is the foundation).

These stay in `action-plan.md` as future workstreams. Don't expand scope here.

---

## First move

Start with **T1.1**: discover omp's on-disk layout. Everything in Phase 1 depends on knowing where omp writes its session state and what's in those files. One research pass, one document, then the rest of Phase 1 is straightforward adapter code following the pattern already established in `src/adapters/`.
