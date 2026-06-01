# Sub-Plan: Ambient Tasks — Reuse Provider Session IDs

> Parent: `docs/action-plan.md` — extends Workstream 1 (Task Intent System)
> Builds on: `docs/sub-plan-omp-and-url-scheme.md` (must ship first)
> Status: drafted 2026-06-01
> Ordering: Phase A ships first (read-only), Phase B opt-in after.

---

## Why this plan exists

Today ATEM forces the human to declare a task *before* work exists:
`atem start "fix oauth" --type implementation --repo .` That's
backwards — the provider is already running, the work already has shape,
and we're minting a parallel TASK-N identifier for no benefit.

Every provider already issues a stable, unique session id:
- omp: `01HGY4Z2-abc` (UUID, persisted in jsonl header)
- Claude Code: `sessionId` in `~/.claude/sessions/*.json`
- Codex: workspace + session id
- Cursor: chat id

**A task id should be `<provider>:<provider-session-id>` by default.**
TASK-001 and human-typed names (`fix-oauth`) become *aliases* over those
synthetic ids, not the canonical form.

The Phase 1 + Phase 2 work we shipped (omp detection, distillation,
`atem://` URLs, handle farm) gives us 90% of the plumbing. This plan is
the last 10% — and the opinionated bit about *when* to create files.

---

## Goal

> Open your editor. Run a provider. ATEM sees it, gives it a stable id,
> lets any other provider step into it via `atem://current/handoff` —
> without you ever typing `atem start`.

---

## Two-phase split (deliberate)

**Phase A** introduces synthetic ids but does NOT materialize session
files. It's pure display + URL routing. Cost is near-zero; it lets us
answer the *naming-model* question (do synthetic ids feel right?) before
we commit to opinionated lazy-creation logic.

**Phase B** adds materialization-on-demand: the first read or write
through `atem://<synthetic-id>/...` creates the ATEM session dir from
the provider's distilled state. This is where Workstream 1's
task-type defaulting plays in.

Live with Phase A for a week (or however long you need) before
shipping B. If A feels wrong, B is wasted code.

---

## Phase A — Synthetic IDs, read-only

### Goal

`atem status` shows ambient tasks with `<provider>:<id>` identifiers.
`atem://omp:<uuid>/<artifact>` resolves and points at omp's own files
(not ATEM session files). No new ATEM session dirs are created.

### Out of scope (for Phase A only)

- Materializing session files
- Task-type defaulting
- Aliases (Phase B)
- Handoff to/from synthetic tasks (Phase B)

### Tasks

**T A.1 — Synthetic id derivation**
- New helper in `src/synthetic.js`: `deriveSyntheticId(provider, providerSessionId)`
  → returns `"omp:01HGY4Z2-abc"`.
- Short-display helper: `shortId(syntheticId, n = 4)` → `"omp:01HG"`.
- Unit tests for collisions, weird chars, length.

**T A.2 — Detection adapters expose synthetic ids**
- Extend the existing `getOmpSessions()` (already returns `sessionId`)
  to also stamp `ompSession.syntheticId = "omp:" + sessionId`.
- Do the same for `getClaudeSessions()`, codex, cursor where we can
  read a real id. Where we can't, emit `"<provider>:cwd:<sha8(cwd)>"`
  as a stable fallback.
- No new functions in cli.js; the existing collectors gain one field.

**T A.3 — `atem status` shows a "Detected sessions" table**
- After the provider summary, render rows: `ATEM id | Title | cwd | live`.
- Source: every detected session whose synthetic id is non-empty.
- Sort: live first, then mtime desc.
- Truncate to 10 by default; `--all` flag prints everything.

**T A.4 — URL resolver accepts synthetic ids**
- `src/url.js`: when `parsed.target` matches `/^[a-z][\w-]*:.+/`, treat
  it as a synthetic id. Look up the provider adapter (`omp`, `claude-code`,
  …) and ask it for the provider-side path corresponding to the
  artifact (`handoff` → distilled view, `state` → live distilled state, etc).
- Returns `{ kind: "virtual", payload, mimeType: "text/markdown" }` so
  `atem resolve` and `atem://`-aware readers get content without any
  ATEM session dir existing.

**T A.5 — Provider adapters implement `resolveSynthetic(artifact)`**
- New method on each adapter: `resolveSynthetic(syntheticId, artifact)
  → { content, mimeType }`.
- omp's implementation: call `distillSessionSync` and project the
  distilled object into markdown matching the artifact requested
  (handoff → "what omp is doing now"; state → live state; brief →
  firstTask; next → "(synthetic; promote to materialize)").
- Other providers: stub returning `"<provider>: read-only synthetic
  session. Promote with \`atem adopt --from <id>\` to write."`.

**T A.6 — `atem resolve` outputs virtual payloads inline**
- Already does for `atem://list`. Extend the JSON-or-content path to
  print markdown for `kind: "virtual"` when mimeType is text/markdown.
- Add `--raw` to print the JSON envelope for tool consumption.

**T A.7 — Tests**
- Synthetic id derivation: unit tests in `test/synthetic.test.js`.
- `atem status` with a synthetic omp session: snapshot test on the
  rendered table.
- `atem resolve atem://omp:<uuid>/state`: returns markdown from the
  distilled omp session (no ATEM session dir created — verify via
  filesystem snapshot).

### Success criteria

- A user who runs omp and does nothing else can see their work in
  `atem status` as an `omp:<id>` row.
- `atem resolve atem://omp:<id>/<artifact>` returns useful markdown.
- `~/.atem/harness/sessions/` is unchanged — no new dirs created.
- Existing TASK-N workflows are untouched (regression test: the
  Phase 1/2 test suite still passes verbatim).

---

## Phase B — Materialization on demand

### Goal

`atem handoff <synthetic-id> --to <provider>` and any `writeUrl` to a
synthetic-id URL automatically materializes a real ATEM session dir
populated from the provider's distilled state. After that, the
synthetic id behaves exactly like a TASK-N id.

### Tasks

**T B.1 — Materializer module**
- New `src/materialize.js`:
  `materializeSyntheticTask(syntheticId, paths, opts) → { taskId, sessionDir, distilled }`.
- Logic: derive provider from the id prefix, look up the adapter, call
  its `ingest()` / `distill()` to populate `brief.md`, `state.md`,
  `handoff.md`, `decisions.md`, `next.md`, `validation.md`, `log.md`
  under `sessions/<syntheticId>/`.
- Idempotent: if the session dir exists, no-op.

**T B.2 — Lazy hooks at the URL boundary**
- `src/url.js`: when resolving `atem://<synthetic-id>/<artifact>`, if
  the underlying session dir does NOT exist and the caller is doing a
  write (or the resolver is called via `atem handoff` / `atem ingest`),
  invoke `materializeSyntheticTask` first.
- Pure reads of unmaterialized synthetic ids stay virtual (Phase A
  behavior preserved).
- One opt-out: `?raw=true` on the URL skips materialization.

**T B.3 — Alias table**
- `sessions/.aliases.json`: `{ "fix-oauth": "omp:01HG...", ... }`.
- `src/aliases.js`: read/write atomically.
- URL resolver checks aliases before the synthetic-id pattern.
- `atem adopt <synthetic-id> --name <alias>` writes the alias entry
  AND materializes the task (because the user is signaling commitment).

**T B.4 — Task type defaulting**
- New `inferTaskTypeFromProvider(provider, distilled)` helper:
  - omp `mode === "plan"` → `investigation`
  - omp with `firstTask` mentioning "fix"/"implement"/"add" → `implementation`
  - omp with `firstTask` mentioning "read"/"investigate"/"why" → `investigation`
  - default: `investigation` (safest)
- Materializer writes the inferred type into the brief and state
  frontmatter.
- Doctor warning: a materialized synthetic task whose type is still
  the inferred default after N writes should be promoted with
  `atem adopt --type`.

**T B.5 — Handoff supports synthetic ids end-to-end**
- `commandHandoff` already takes a task id string. Extend the check
  that calls `requireSession` to first run materialization if the id
  is synthetic.
- `--from <provider>` already does ingestion when explicit; that path
  is unchanged.

**T B.6 — `atem adopt --auto` materializes everything detected**
- New flag on `commandAdopt`. Iterates `getDetectedSyntheticIds()` and
  materializes each into its own session dir. Useful for "I want to
  bulk-track all my running providers."
- Skips already-materialized ids.

**T B.7 — Handle farm covers synthetic + alias paths**
- `src/handles.js`: after materialization, sync the same way as TASK-N
  tasks. Add an additional symlink per alias:
  `~/.atem/handles/fix-oauth/` → `~/.atem/handles/omp:01HG.../`.
- Doctor validates alias symlinks.

**T B.8 — Doctor checks**
- Warn on synthetic ids in `current-session.md` that have no on-disk
  session dir (impossible if Phase B is wired right, but defensive).
- Warn on alias entries pointing at nonexistent synthetic ids.
- Warn on unmaterialized synthetic tasks that have received > N writes
  (indicates the lazy hook missed).

**T B.9 — Tests**
- E2E: create synthetic omp session → `atem handoff omp:<id> --to codex`
  → assert session dir exists and contains distilled content.
- Alias round-trip: `atem adopt omp:<id> --name foo` → `atem resolve
  atem://foo/state` returns the same path as `atem://omp:<id>/state`.
- Task-type inference: synthetic session with `mode: plan` → brief has
  `task_type: investigation`.
- `atem adopt --auto`: synthesizes N detected sessions, materializes all.

### Success criteria

- `atem handoff omp:<id> --to <provider>` works without prior `atem start`.
- Aliases map to synthetic ids transparently across `resolve`, `handoff`,
  `status`, and the handle farm.
- Task type is inferred conservatively (defaults to investigation when
  unsure), with doctor surfacing untyped tasks.
- All Phase 1/2 tests still pass.

---

## Execution order and dependencies

```
Phase A
  T A.1 → T A.2 → T A.3 (display)
              ↘  T A.4 → T A.5 (URL routing → adapters)
                            ↘  T A.6 (resolve CLI) → T A.7 (tests)

[ pause; live with read-only synthetic ids; gather feedback ]

Phase B
  T B.1 (materializer) → T B.2 (lazy hooks) → T B.5 (handoff e2e)
                       ↘ T B.4 (task type)
  T B.3 (aliases) → T B.7 (handles for aliases)
  T B.6 (adopt --auto) → T B.8 (doctor) → T B.9 (tests)
```

T A.4 depends on the existing `src/url.js` resolver (Phase 2). T A.5
depends on the omp distiller (Phase 1). T B.1 reuses the same distiller.
Nothing here requires changes to provider code.

---

## What this defers

- **Stream-rule enforcement at the adapter layer.** Separate sub-plan;
  builds on the same adapter contract this plan extends.
- **Multi-provider concurrent-write merge.** The hash-anchored write
  from Phase 2 is the foundation; merge logic stays out of scope.
- **Provider-side session lifetime modeling.** We accept "same session
  id from the provider = same ATEM task" and let the provider decide
  what "same session" means. Don't try to second-guess.

---

## Honest rough edges (carry over from the design discussion)

1. **First interaction pays the distillation cost.** The first command
   on a synthetic task does real I/O against the provider's session file.
   Document in `atem status` output or via a `(first command is slower)`
   note.

2. **Same cwd, two omp sessions.** Two terminals running `omp` in the
   same repo = two synthetic ids. `atem status` lists both. The user
   picks. No auto-merge — guesses corrupt context.

3. **Cross-provider handoff keeps the originator's id.** Hand
   `omp:01HG...` to Codex; Codex picks it up; the task is still
   `omp:01HG...`. The provider chain is recorded in `state.md`, not in
   the id. This is deliberate — minting new ids at each hop would break
   aliases and links.

---

## First move

**T A.1 + T A.2** — derivation helper + stamp `syntheticId` onto the
existing detection results. Pure additive, no behavior change. Run
existing tests to confirm zero regressions, then add T A.3 to make the
new ids visible in `atem status`. After that, decide whether to keep
going with Phase A or pause.
