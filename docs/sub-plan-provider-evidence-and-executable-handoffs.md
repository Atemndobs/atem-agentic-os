# Sub-Plan: Provider Evidence and Executable Handoffs

> Status: drafted 2026-07-24 — implementation not started
>
> Planned at commit: `85d39bc`
>
> Origin:
> `docs/research/2026-07-24-trending-agent-repos-machine-wide-assessment.md`

## Goal

Turn the most useful patterns from the reviewed agent repositories into a
sequence of small, provider-neutral ATEM improvements:

1. make Codex handoff visibility diagnosable;
2. make Codex-originated sessions genuinely distillable;
3. make handoff plans executable and drift-aware;
4. represent provider activity as consent-aware observations;
5. integrate terminal runtimes such as Herdr without making ATEM a terminal
   multiplexer.

The first two slices address an already observed failure mode: a Codex thread
can disappear from the Desktop sidebar while its ATEM task, SQLite row, and
rollout still exist. The later slices generalize the reliability model across
providers.

## Why this order

The tempting first move is to add a large execution schema or connect Herdr.
That would build on an unreliable provider evidence layer.

The correct dependency chain is:

```text
Codex evidence reader
  -> visibility diagnostic
  -> Codex distiller
  -> provider observations
  -> executable plan state
  -> runtime integrations
```

The diagnostic is deliberately first because it is read-only, independently
useful, and creates reusable storage readers for the distiller.

## Architectural rules

These rules apply to every phase.

1. ATEM session files remain the durable source of task intent, ownership,
   decisions, validation, and handoff state.
2. Provider-native files and databases are evidence, not ATEM state.
3. Desktop sidebar or UI visibility is a volatile observation, never proof of
   existence or deletion.
4. Reading provider state must not mutate provider state.
5. Optional provider evidence must degrade to `unavailable`, not make normal
   ATEM commands fail.
6. Every observation records its source and freshness.
7. Tests use synthetic fixtures under temporary homes. They never read the
   developer's real `~/.codex`, `~/.claude`, process table, or credentials.
8. ATEM remains zero-dependency and compatible with Node.js 20+ on macOS,
   Linux, and Windows.
9. No SQLite implementation may rely on `node:sqlite`, because ATEM supports
   Node 20. The optional `sqlite3` executable may be used behind graceful
   capability detection.
10. No phase may add PTY ownership, transparent traffic interception, model
    proxying, or autonomous security scanning to ATEM.

## Existing implementation to preserve

The executor must read these files before changing code:

- `src/adapters/index.js`
  - `makeProviderAdapter`
  - `renderSyntheticArtifact`
  - existing rich provider registrations
- `src/adapters/claude-code.js`
  - provider-native transcript discovery and normalized distillation exemplar
- `src/materialize.js`
  - `materializeSyntheticTask`
  - provider-specific lookup branches
- `src/synthetic.js`
  - provider ID parsing and ambient-session conventions
- `src/launchers/codex.js`
  - Codex app-server bridge
  - best-effort SQLite first-message population
  - workspace-root hint update
  - `codex://threads/<id>` deep links
- `src/web/scan.js`
  - current bounded Codex rollout read for project-root discovery
- `src/cli.js`
  - command dispatch, help text, tables, JSON conventions, `commandDoctor`
- `test/claude-code-adapter.test.js`
  - rich provider adapter fixture and end-to-end materialization pattern
- `test/launchers.test.js`
  - Codex workspace hints and deep-link fixtures
- `test/web-scan.test.js`
  - bounded `session_meta` fixture

Do not move or rewrite these modules in the first phase. Extract shared helpers
only when a test demonstrates the duplication being removed.

## Plan index

| ID | Slice | Depends on | Status |
|---|---|---|---|
| P1 | Read-only Codex evidence diagnostic | none | planned |
| P2 | Rich Codex session distiller | P1 | planned |
| P3 | Executable handoff plan contract | P2 | planned |
| P4 | Provider observations and UI health | P1, P2 | planned |
| P5 | Herdr runtime adapter spike | P4 | deferred |
| P6 | Machine-wide media/routing/security pilots | none; separate repos | recommendation only |

---

# P1 — Read-only Codex evidence diagnostic

## Outcome

Given a Codex thread ID, ATEM can explain which layers exist and why the thread
may or may not be visible:

```bash
atem doctor codex <thread-id>
atem doctor codex <thread-id> --json
```

The report must distinguish:

- ATEM task/session path;
- active rollout path;
- archived rollout path;
- Codex SQLite thread row;
- SQLite archive flag;
- `first_user_message` and preview presence;
- workspace-root hint;
- inferred working directory;
- Desktop deep link;
- overall classification.

Suggested classifications:

| Classification | Meaning |
|---|---|
| `healthy` | rollout and SQLite row exist; no hidden/archive evidence |
| `archived` | provider evidence exists and the provider marks it archived |
| `hidden` | durable evidence exists but sidebar prerequisites/hints are absent |
| `rollout-only` | rollout exists but SQLite row could not be found |
| `database-only` | SQLite row exists but rollout could not be found |
| `unavailable` | an optional evidence source cannot be inspected |
| `missing` | no known evidence exists |

`unavailable` is a source-level state and may coexist with an overall
classification. For example, a rollout can be `healthy` while SQLite evidence
is unavailable because `sqlite3` is not installed.

## Scope

### In scope

- `src/adapters/codex.js` — new read-only Codex storage/evidence module
- `src/cli.js` — `doctor codex` parsing, human output, and JSON output
- `test/codex-adapter.test.js` — new fixture-driven evidence tests
- `test/phase1.test.js` or a new focused CLI test file — command behavior
- `README.md` and `docs/commands.md` — command documentation

### Explicitly out of scope

- changing `src/launchers/codex.js` launch behavior;
- writing to `state_5.sqlite`;
- moving or unarchiving rollout files;
- altering `.codex-global-state.json`;
- fixing sidebar hints;
- materializing a Codex synthetic task;
- showing the report in the web UI;
- reading arbitrary SQLite columns or dumping transcript content.

## Data contract

`src/adapters/codex.js` should return a stable, provider-neutral diagnostic
shape:

```js
{
  provider: 'codex',
  threadId,
  observedAt,
  sources: {
    atem: {
      available,
      sessionPath,
      archived,
    },
    rollout: {
      available,
      location: 'active' | 'archived' | null,
      path,
      cwd,
      startedAt,
    },
    database: {
      available,
      reason,
      rowFound,
      archived,
      firstUserMessagePresent,
      previewPresent,
      cwd,
      title,
    },
    workspaceHint: {
      available,
      path,
    },
  },
  deepLink,
  classification,
  warnings,
}
```

The public JSON must contain booleans and paths, not raw prompt text, transcript
content, tokens, credentials, or full database rows.

## Implementation steps

### P1.1 — Add bounded Codex path and rollout discovery

In `src/adapters/codex.js`:

1. Resolve the Codex root from an injected option first, then the supported
   environment/config convention, then `~/.codex`.
2. Search only the known active and archived session roots.
3. Match the thread ID against filenames and bounded JSONL content.
4. Read only enough JSONL to identify `session_meta`, thread identity, cwd, and
   timestamps.
5. Return explicit source availability and parse warnings.
6. Never recurse outside the configured Codex roots.

Verification:

```bash
node --test test/codex-adapter.test.js
```

Expected:

- active rollout found;
- archived rollout found;
- malformed JSONL skipped with a warning;
- missing roots return `available: false` or an empty result without throwing;
- a similarly named unrelated rollout is not selected.

### P1.2 — Add optional, read-only SQLite inspection

1. Detect `sqlite3` with the existing `whichSync` helper.
2. Validate the thread ID before constructing a query.
3. Query only the single matching row and only the columns needed by the
   diagnostic.
4. Use JSON output if the installed SQLite supports it; otherwise parse a
   deliberately delimited single row.
5. Treat missing binary, missing database, locked database, unknown schema, and
   missing columns as source-level `unavailable` results.
6. Never execute an UPDATE, PRAGMA mutation, schema migration, or copy-back.

Verification:

```bash
node --test test/codex-adapter.test.js
```

Expected:

- fixture query maps a row to the normalized booleans;
- missing `sqlite3` produces a useful reason and no exception;
- unexpected schema produces a useful reason and no exception;
- invalid thread IDs are rejected before any subprocess call;
- the test records that the executed SQL begins with `SELECT`.

### P1.3 — Read the workspace hint without exposing global state

1. Read only `thread-workspace-root-hints[threadId]` from Codex's known global
   state file.
2. Handle missing, malformed, or differently shaped state as unavailable.
3. Do not return unrelated thread IDs or global state.

Verification:

```bash
node --test test/codex-adapter.test.js
```

Expected:

- matching hint returned;
- unrelated hints excluded;
- malformed JSON degrades without throwing.

### P1.4 — Join ATEM evidence and classify

1. Look for exact task IDs and aliases through ATEM's existing handle/session
   helpers.
2. Include active and ATEM-archived session evidence separately.
3. Implement classification as a pure function over normalized sources.
4. Add table-driven tests for every classification.

Verification:

```bash
node --test test/codex-adapter.test.js
```

Expected:

- all classification rows pass;
- classification does not depend on filesystem calls;
- provider archive state is not described as deletion.

### P1.5 — Add `atem doctor codex`

1. Change `commandDoctor(gitRoot)` to receive its argument list without
   changing the existing no-argument behavior.
2. Parse only:
   - `atem doctor`
   - `atem doctor codex <thread-id>`
   - `atem doctor codex <thread-id> --json`
3. Render the normalized report as a compact table.
4. In JSON mode, write exactly one JSON document to stdout.
5. Exit nonzero only for invalid CLI usage or an internal programming error.
   Missing provider evidence is a valid diagnostic result.

Verification:

```bash
node --test test/codex-adapter.test.js test/phase1.test.js
node bin/atem.js doctor
```

Expected:

- legacy doctor tests and behavior remain unchanged;
- fixture thread reports each evidence layer;
- JSON output parses;
- `missing` is reported without a stack trace;
- no files under the fixture Codex root change.

### P1.6 — Document the command and trust boundary

Document:

- every path inspected;
- why it is inspected;
- that SQLite access is read-only and optional;
- that no transcript/prompt content is printed;
- that sidebar absence is not deletion;
- platform degradation when `sqlite3` is unavailable.

Verification:

```bash
rg -n "doctor codex|read-only|sidebar" README.md docs/commands.md
git diff --check
```

Expected:

- command appears in both documentation surfaces;
- trust-boundary wording is explicit;
- no whitespace errors.

## P1 STOP conditions

Stop and report instead of improvising if:

- the current Codex SQLite schema cannot identify archive state without
  reading sensitive unrelated data;
- matching a thread ID requires scanning outside known Codex session roots;
- the diagnostic would need to write provider state;
- a cross-platform implementation would require adding a package dependency;
- existing `doctor` behavior cannot remain backward compatible;
- real user prompts, tokens, or credentials appear in test fixtures or output.

## P1 done criteria

- `atem doctor codex <id>` explains all available evidence layers.
- `--json` is stable and machine-readable.
- all provider reads are bounded and read-only.
- missing optional tools degrade gracefully.
- tests use only temporary fixtures.
- the full test suite passes.

Final verification:

```bash
npm test
git diff --check
```

---

# P2 — Rich Codex session distiller

## Outcome

Codex becomes a first-class rich synthetic provider:

```bash
atem resolve atem://codex:<thread-id>/handoff
atem adopt codex:<thread-id>
atem handoff codex:<thread-id> --to claude-code --repo <path>
```

The generated brief, state, and handoff must come from the rollout transcript,
not from Desktop sidebar metadata.

## Scope

### In scope

- extend `src/adapters/codex.js` with normalized distillation;
- register a rich Codex adapter in `src/adapters/index.js`;
- add the Codex branch to `src/materialize.js`;
- expose recent Codex sessions through existing ambient-session mechanisms;
- expand `test/codex-adapter.test.js`;
- add end-to-end resolve/adopt/handoff tests.

### Out of scope

- changing Codex launcher behavior;
- importing hidden chain-of-thought or encrypted payloads;
- treating SQLite preview text as transcript truth;
- UI health or quota display;
- background job orchestration.

## Normalized distillation contract

Match the shape already consumed by `renderSyntheticArtifact`:

```js
{
  sessionId,
  cwd,
  title,
  firstTask,
  summary,
  lastAssistantText,
  startedAt,
  updatedAt,
  pausedMidTool,
  labels,
}
```

Codex-specific fields may be returned under an `observations` property, but the
shared renderer must not require them.

## Implementation steps

### P2.1 — Parse rollout events into a normalized conversation

Follow the Claude Code adapter's principles:

- accept known user and assistant message forms;
- ignore reasoning/private internal payloads;
- track tool-call/tool-result balance only when identifiers are available;
- keep the first real user task;
- keep the last user-visible assistant text;
- bound retained text;
- tolerate unknown event variants.

Verification:

```bash
node --test test/codex-adapter.test.js
```

Expected:

- representative event variants distill correctly;
- unknown events do not fail the session;
- private reasoning is never surfaced;
- truncated/malformed final lines do not discard earlier valid content.

### P2.2 — Register Codex as a rich adapter

In `src/adapters/index.js`:

- import the Codex adapter;
- use `renderSyntheticArtifact('codex', ...)`;
- expose discovery and distillation through the same `external` convention as
  Claude Code, OMP, Cursor, and OpenCode;
- remove Codex from the placeholder-only path.

Verification:

```bash
node --test test/codex-adapter.test.js test/adapter.test.js
```

Expected:

- `atem://codex:<id>/handoff` contains distilled content;
- unknown Codex IDs produce the standard not-found error;
- other provider adapters are unchanged.

### P2.3 — Materialize Codex synthetic sessions

In `src/materialize.js`, add a Codex lookup/distill branch using the adapter.
Do not put Codex parsing logic in `materialize.js`.

Verification:

```bash
node --test test/codex-adapter.test.js
```

Expected:

- adopt creates the seven canonical ATEM artifacts;
- repeated adopt is idempotent;
- task type inference uses the existing provider-neutral logic;
- source rollout and SQLite files remain byte-identical.

### P2.4 — Complete reverse handoff

Add an end-to-end test modeled on
`test/claude-code-adapter.test.js`:

```text
Codex fixture rollout
  -> synthetic Codex ID
  -> materialized ATEM task
  -> printed Claude Code handoff prompt
```

Verification:

```bash
node --test test/codex-adapter.test.js test/claude-code-adapter.test.js
npm test
```

Expected:

- handoff prompt contains the original task and last visible progress;
- no placeholder "no rich distiller" text remains;
- all existing tests pass.

## P2 STOP conditions

Stop and report if:

- the rollout format does not expose user-visible messages without relying on
  unstable private reasoning fields;
- thread identity cannot be verified;
- the adapter needs SQLite text to reconstruct the conversation;
- materialization would overwrite an existing ATEM task;
- fixture data cannot represent the real format without copying sensitive
  local content.

---

# P3 — Executable handoff plan contract

## Outcome

An ATEM task may carry a provider-neutral, machine-checkable execution plan
without making it mandatory for existing tasks.

## Design decision required before implementation

Choose one storage shape:

### Option A — `execution.json` sidecar (recommended)

Pros:

- handles nested steps, arrays, evidence, and verification cleanly;
- no YAML dependency;
- easy schema validation;
- machine-readable without parsing Markdown.

Cons:

- becomes an eighth canonical artifact;
- URL, recovery, web scan, snapshots, and packaging must learn it.

### Option B — fenced JSON block in `next.md`

Pros:

- preserves seven canonical files;
- human context and execution details stay together.

Cons:

- extraction and rewrite are more fragile;
- diffs mix prose and machine state;
- concurrent edits are harder to anchor safely.

Do not encode nested execution data in the current simple YAML frontmatter
parser. It supports scalar session metadata, not a nested workflow document.

## Proposed `execution.json` contract

```json
{
  "schema": "atem.execution.v1",
  "planned_at_commit": "85d39bc",
  "status": "planned",
  "executor_profile": {
    "capabilities": ["node", "tests"],
    "provider": null,
    "model": null
  },
  "scope": {
    "include": [],
    "exclude": []
  },
  "steps": [
    {
      "id": "step-1",
      "action": "",
      "verify": {
        "command": "",
        "expected": ""
      },
      "status": "pending",
      "evidence": []
    }
  ],
  "stop_conditions": [],
  "verdict": {
    "state": "pending",
    "summary": "",
    "findings": []
  }
}
```

## Required behavior

- optional for all existing sessions;
- schema versioned;
- reject unknown required enum values;
- preserve unknown additive fields when rewriting;
- compare `planned_at_commit` before execution;
- support explicit `approve`, `revise`, and `block` verdicts;
- verification evidence must state whether a command ran, its exit status, and
  when it ran;
- never store secrets or raw credential-bearing logs.

## Likely files

- new `src/execution.js` for pure validation and state transitions;
- `src/url.js` for the optional artifact alias;
- `src/recovery.js` for validation only when the sidecar exists;
- `src/web/scan.js` and `src/web/server.js` for read-only display;
- `src/cli.js` for plan status and evidence commands;
- new `test/execution.test.js`;
- updates to URL, recovery, web, and snapshot tests.

## Verification gates

Each sub-step must keep these passing:

```bash
node --test test/execution.test.js
node --test test/url-scheme.test.js test/recovery.test.js
node --test test/web-scan.test.js test/web-server.test.js
npm test
```

## P3 STOP conditions

Stop and request a design decision if:

- the user prefers the fenced `next.md` shape;
- optional execution state would make old sessions fail recovery;
- implementing it requires a YAML or validation dependency;
- evidence storage risks capturing secrets or unbounded logs;
- the CLI would begin executing work automatically rather than recording and
  validating the plan.

---

# P4 — Provider observations and UI health

## Outcome

ATEM can display provider activity and health without confusing observation
with task state.

## Observation contract

```js
{
  provider,
  observedAt,
  source,
  freshnessMs,
  availability: 'available' | 'degraded' | 'unavailable',
  activity: 'working' | 'waiting' | 'finished' | 'idle' | 'unknown',
  health: 'closed' | 'degraded' | 'open' | 'half_open' | 'unknown',
  constraints: {
    rateLimitedUntil: null,
    quotaPressure: null,
  },
  consent: {
    required: false,
    granted: null,
    purpose: '',
  },
  warnings: [],
}
```

The circuit-breaker vocabulary is observational in this phase. It must not
automatically reroute tasks.

## Privacy matrix

Before implementing a source, document:

| Source | Data read | Purpose | Consent | Retention |
|---|---|---|---|---|
| known session file | bounded metadata | activity/freshness | installation disclosure | derived snapshot only |
| provider database | selected row/columns | visibility diagnostic | explicit documentation | no copied row |
| process list | process name; command line only if needed | working/waiting inference | explicit opt-in | latest timestamp only |
| usage endpoint/config | quota/limit metadata | provider pressure | provider-specific | normalized snapshot |

Do not crawl project files or retain command lines by default.

## Phases

1. Define the pure observation type and merge/freshness rules.
2. Map Codex diagnostic evidence into observations.
3. Map existing Claude Code/OpenCode/OMP activity into the same shape.
4. Add a read-only API response in `src/web/server.js`.
5. Add a compact provider-health strip to `src/web/app.html`.
6. Add permission controls only when a source actually requires consent.

## Verification

```bash
node --test test/provider-observations.test.js
node --test test/web-server.test.js test/web-scan.test.js
npm test
```

Expected:

- stale observations are visibly stale;
- unavailable sources do not imply provider failure;
- observation never changes task `provider` or `status`;
- the web server remains bound to `127.0.0.1`;
- denied optional consent leaves the rest of the UI functional.

---

# P5 — Herdr runtime adapter spike

> Deferred until P4 defines the observation boundary.

## Goal

Prove that ATEM can associate a durable task with a Herdr workspace and read
runtime attention state through Herdr's documented socket API.

## In scope

- capability detection;
- read-only socket/API status;
- explicit task-to-workspace association;
- launch/focus command behind user action;
- normalized observation mapping;
- deep link or documented focus action.

## Out of scope

- PTY creation or ownership in ATEM;
- terminal rendering;
- remote terminal transport;
- copying Herdr persistence files;
- making Herdr mandatory;
- automatically terminating sessions.

## Spike success criteria

- ATEM works unchanged when Herdr is absent.
- One fixture or fake socket server proves the adapter protocol.
- A task can show `working`, `waiting`, `finished`, or `unknown`.
- The association is explicit and reversible.
- No provider task state is inferred solely from terminal exit.

## STOP conditions

Stop the spike if:

- Herdr lacks a stable documented read API for the needed state;
- the integration would require scraping its screen;
- ATEM would need to own PTYs or daemon lifecycle;
- the association cannot be represented without provider-specific state in
  canonical session files.

---

# P6 — Machine-wide pilots outside ATEM

These are recommendations, not authorization to modify sibling repositories,
install global tools, change credentials, or deploy services.

## Video understanding pilot

Evaluate `bradautomates/claude-video` on one real research video:

- captions-first;
- local/API transcription fallback;
- focused time ranges;
- scene/keyframe selection;
- near-duplicate removal;
- explicit frame/token budget;
- evidence report showing omissions.

Measure:

- setup friction;
- wall-clock time;
- transcript accuracy;
- visual evidence quality;
- frames retained/dropped;
- approximate token cost;
- privacy implications.

## Meetily pilot

Evaluate separately as a desktop tool for local meeting capture. Confirm:

- recording consent workflow;
- local storage location;
- deletion/export behavior;
- transcription model footprint;
- diarization accuracy;
- whether it duplicates existing Granola or voice workflows.

## OmniRoute pilot

Only in an isolated homelab test:

- two non-production providers;
- test credentials;
- no transparent MITM;
- no memory;
- no production prompts;
- deterministic fallback cases;
- before/after latency, quality, and cost;
- clean rollback.

## Strix pilot

Only against a disposable, explicitly authorized local target. Never run it
against production, third parties, or the homelab by default.

## PixelRAG pilot

Create a small benchmark where spatial layout matters and compare:

- text/DOM retrieval;
- screenshot retrieval;
- combined retrieval;
- accuracy;
- latency;
- storage;
- model cost.

---

# Overall completion criteria

This plan is complete when:

1. Codex thread visibility can be diagnosed without mutation.
2. Codex sessions can be distilled and handed to another provider with real
   context.
3. An approved, optional execution-plan contract exists and is backward
   compatible.
4. Provider observations are source-labeled, freshness-aware, and do not
   silently mutate task state.
5. Herdr integration, if pursued, stays behind the runtime adapter boundary.
6. Machine-wide pilots remain explicit, isolated evaluations rather than
   default infrastructure changes.
7. ATEM remains zero-dependency, Node 20+, and cross-platform.
8. `npm test` and `git diff --check` pass after every independently mergeable
   slice.

# Recommended first implementation PR

Implement **P1 only**.

Do not combine P1 with the distiller, execution schema, UI health strip, or
Herdr adapter. P1 should be reviewable as a read-only reliability feature with
no provider-side mutations and no new dependency.
