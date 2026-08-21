# Sub-plan: DeepSeek Harness as an ATEM provider (+ handoff learnings)

> Date: 2026-08-21
> Status: Draft (planned)
> Origin: [ADR-002](decisions/002-dsh-harness-peer.md) decision 2 (gate now met)
> Depends on / relates to: [sub-plan-event-log-task-store](sub-plan-event-log-task-store.md)
> Verified against: dsh built + run locally, see project-deepseek-harness-local memory

## Framing

Two separate verbs, two separate tracks:

- **Leverage dsh** = make it a first-class provider ATEM detects, hands
  off to, and ingests from. Small, concrete, do now (Track A).
- **Adapt from dsh** = borrow its session and continuity design into
  ATEM's own handoff implementation. Structural, staged (Track B).

dsh is a harness (it runs the loop). ATEM is the mesh above harnesses.
This sub-plan does not change that boundary; it slots dsh into the
provider matrix and harvests design lessons.

## Verified facts (from the local run)

- **One-shot lane:** `dsh --profile headless "task"` runs one fresh
  persisted session in the invoking directory, prints the last
  assistant text to stdout, exits 0 on `turn/end` else 1, opens no
  port. This matches ATEM's existing seed-turn launchers
  (`opencode run "<seed>"`, `claude -p`).
- **Native `AGENTS.md`:** dsh injects root and nested (`packages/AGENTS.md`)
  instructions as context. ATEM's existing AGENTS.md writer already
  satisfies dsh's prompt-ingestion path.
- **State on disk:** `~/.dsh/` holds `settings.yaml` (providers),
  `storages/workspace.json` (workspace paths), and
  `storages/session_projcache.json` (per-session cwd, tokenUsage, TTFT,
  decode stats, contextPressure). Plain JSON, no SQLite.
- **Protocols:** dsh ships ACP (`packages/acp`, `examples/acp-agent`,
  `subagent-acp`) and JSON-RPC (`examples/jsonrpc-agent`) surfaces.
- **Session substrate:** the headless runner "folds the owned durable
  event interval" to produce output. The append-only event log is the
  source of truth; a session is foldable and resumable.

## Track A: dsh as a provider

### A0. Spike ACP first (~1-2h, decides A2): DONE, PASS

**Outcome (2026-08-21): ACP works; the launcher is the generic ACP path.**
An ATEM-side client drove dsh over ACP stdio end to end (`initialize` →
`session/new` → `session/prompt`), backed by local Ollama, and got a
committed answer. See [spikes/dsh-acp/FINDINGS.md](../spikes/dsh-acp/FINDINGS.md).
Key consequence: ACP is the outbound (`--to dsh`) launcher seam and
generalizes to any ACP agent; ingest (`--from dsh`) must read `~/.dsh`
state instead, since the ACP demo supports fresh sessions only.

Original spike question, for the record:

dsh speaks ACP (Agent Client Protocol), an emerging cross-agent
standard. ATEM's launchers are today per-provider CLI hacks (Codex
JSON-RPC bridge, `cursor --reuse-window`, `opencode run`,
`claude --resume`). If ATEM adds one **ACP launcher**, dsh is the first
client and any future ACP-speaking agent works through the same path.

Spike question: can ATEM drive `examples/acp-agent` over stdio ACP with
a seed prompt and a workspace, and read back a completion? If yes, the
launcher is generic (bigger payoff). If ACP setup is heavy, fall back
to the bespoke headless launcher in A2.

### A1. Detection adapter: `src/adapters/dsh.js`

Mirror the shape of `adapters/opencode.js` / `adapters/cursor.js`, but
read JSON instead of SQLite:

- Enumerate workspaces from `~/.dsh/storages/workspace.json`.
- Enumerate sessions from `~/.dsh/storages/session_projcache.json`
  (`identity.cwd`, `sessionListMetadata.lastPromptAt`, `title`).
- Emit synthetic ids `dsh:<sessionId-short>` scoped to cwd, matching
  the existing ambient-session convention.
- Distillation: fold the session's durable event interval (or, until
  the event-log work lands, read the last assistant text + stats) into
  ATEM's `brief/state/handoff/next` artifacts.

### A2. Launcher: `src/launchers/dsh.js`

Preferred: ACP (from A0). Fallback: headless one-shot.

- Headless fallback: `dsh --profile headless "<seed prompt>"` with
  `cwd = <repo>`. ATEM already writes `AGENTS.md` at the repo root;
  dsh reads it natively, so the seed prompt can be short.
- Fits the `--no-focus` / non-interactive lane (dsh web is a server,
  not a resumable GUI window). Treat dsh like omp for focus behavior:
  no window to raise.
- `--no-respond` analog: headless always runs the task, so the
  "prepare-only, no seed turn" case skips the launcher and just writes
  AGENTS.md + prints the prompt (existing `--print` path).

### A3. Wire-up

- Register in `src/adapters/index.js` and `src/launchers/index.js`.
- Add the dsh row to the provider matrix (README + `atem install --list`).
- MCP installer: only if dsh exposes an MCP client surface for
  registering ATEM as a server; confirm before claiming the column.
- Tests: detection against a fixture `~/.dsh` layout; launcher builds
  the right argv without executing.

### A4. Bidirectional check

- `atem handoff <task> --to dsh` launches dsh seeded with the payload.
- `atem handoff <dsh-session> --from dsh` ingests dsh state into an
  ATEM task (the fold in A1).
- `atem status` lists live/idle dsh sessions alongside the others.

## Track B: adapt dsh's design into ATEM's handoff

### B1. Distillation as a fold over an event log (highest value)

Reframes the [event-log sub-plan](sub-plan-event-log-task-store.md) for
handoff: once the task store is an append-only event log, a handoff is
"transfer/replay an event interval," not "regenerate seven markdown
files and let `reconcile`/`rollback` fight drift." dsh's headless
runner already models the fold. ATEM's distillation should become the
same fold, per provider.

### B2. Carry the trajectory, not just conclusions

Today a handoff bundles conclusions (state, decisions, next). dsh's
Trajectory carries the path: ordered tool calls, reasoning, and each
context injection. Add an **optional compressed trajectory artifact**
to the handoff payload so the receiving provider sees what was tried
and read, not only what was decided. Start with a tool-call log; expand
if useful.

### B3. Carry context-health metadata

dsh tracks `tokenUsage`, TTFT, `contextPressure`, and "% context used".
Add a small **context-budget header** to a handoff so the destination
knows how loaded the prior session was and whether to compact first.
Minor, incremental, lands after the event log.

### B4. Handoff-inspector view in `atem web` (UI learning)

`atem web` shows planning docs. dsh's context-injection UI (named rows
for every file/prompt fed to the model, plus a Trajectory timeline) is
the model for a **handoff preview**: before launching, render the exact
context a handoff will inject into the destination (AGENTS.md + the
auto-discovered project-context bundle + the seed prompt). Turns
handoff from a black box into a previewable payload. Prototype only
after Track A works.

## Order of work

1. A0 spike ACP (decides A2 shape).
2. A1 + A2 + A3: ship the dsh provider (ACP or headless fallback).
3. A4: verify bidirectional handoff + status.
4. B1: land the event-log store; reframe distillation as a fold.
5. B2 + B3: enrich the handoff payload.
6. B4: handoff-inspector view.

Track A (1-3) proves the mesh claim: ATEM coordinates dsh like any
other harness. Track B (4-6) is where dsh's design actually improves
ATEM's own handoff.

## Non-goals

- Not adopting Cordis or dsh's plugin framework.
- Not making ATEM execute work; dsh runs the loop, ATEM coordinates.
- Not changing the seven artifact names/formats providers consume
  (Track B changes how they are produced, not their contract).

## Open questions

- Does dsh expose an MCP client surface for `atem install` (A3)?
- ACP maturity: is `examples/acp-agent` a stable stdio server, or
  demo-only? (A0 answers this.)
- Headless persistence: can ATEM resume a prior dsh session by id, or
  is headless always a fresh session? (Affects `--from dsh` fidelity.)
