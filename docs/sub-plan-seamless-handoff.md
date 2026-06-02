# Sub-Plan: Seamless Handoff — Launch the Destination

> Parent: `docs/action-plan.md` — extends Workstream 3 (adapters).
> Builds on: omp adapter, claude-code adapter, `atem://` URLs, ambient
> tasks, Codex bridge research (`docs/research/codex-bridge.md`).
> Status: drafted 2026-06-01
> One commit per phase; no new top-level CLI verb.

---

## Why this plan exists

Today's handoff: ATEM writes `AGENTS.md` and prints a 30-line prompt to
the terminal. The user then manually opens the destination provider,
navigates to the right worktree, and types "pick up the handoff."

Three frictions:

1. **Context switch.** Terminal → app window.
2. **Path lookup.** User reads the worktree path from terminal output and
   has to navigate the destination app to that exact path.
3. **Redundant typing.** The destination provider would read `AGENTS.md`
   on its own; making the user type a prompt is busywork.

The fix is one upgrade to the *existing* `atem handoff` command: when
the destination has a programmatic launch surface, ATEM uses it. The
human sees a pre-named, pre-scoped, pre-primed session waiting in the
destination's sidebar. **No new verb.**

---

## Decision: one command, not two

I proposed `atem hop` earlier. **Rejected.** Two verbs that mean almost
the same thing create permanent confusion. Instead:

- `atem handoff <task> --to <provider>` — defaults to the most useful
  behavior the destination supports (launch if possible, print otherwise).
- `atem handoff <task> --to <provider> --print` — explicit opt-in for the
  old behavior (script-friendly, no launch attempt).

---

## Goal

> `atem handoff claude-code:0c6014 --to codex` opens a Codex sidebar
> entry already named `atem: claude-code:0c6014`, scoped to the right
> worktree, with the handoff prompt as the first user turn. Terminal
> shows one success line, not 30.

---

## Architecture — the launch table

```
src/launchers/
  index.js          — registry: providerName -> launcher
  print.js          — fallback (writes prompt to stdout)
  codex.js          — JSON-RPC over `codex app-server proxy --sock` (D.3)
  claude-code.js    — `claude --resume <id>` or `claude -p "..."` (D.4)
  // future: cursor.js, omp.js
```

Each launcher exports a small interface:

```ts
type LaunchInput = {
  syntheticId: string,
  fromProvider: string,
  targetRepo: string,             // worktree-aware path
  taskType: string,
  handoffPrompt: string,          // already-built ATEM prompt
  paths: HarnessPaths,
  agentsMdPath?: string,           // already-written by handoff
};

type LaunchResult =
  | { kind: 'launched', summary: string }
  | { kind: 'printed',  summary: string }
  | { kind: 'unavailable', reason: string };

interface Launcher {
  name: string;
  available(): boolean;             // sync; just checks binary + env
  launch(input: LaunchInput): Promise<LaunchResult>;
}
```

`commandHandoff` dispatches:

1. Build `handoffPrompt`, write `AGENTS.md` (existing behavior).
2. If `--print` → use the `print` launcher.
3. Else look up `launchers[provider]`; if available → use it; else `print`.
4. Emit the launcher's `summary` line. No 30-line dump unless `print`.

---

## Phase D.1 — Launch table scaffolding

### Tasks

- **T D.1.1** — `src/launchers/index.js` with `register()` and `get()`.
- **T D.1.2** — `src/launchers/print.js` — refactor existing prompt
  printing out of `commandHandoff` so it lives behind the same interface.
- **T D.1.3** — `commandHandoff` calls into the table; defaults to print
  for unknown providers; `--print` flag forces print.
- **T D.1.4** — Quiet success line: one row, no 30-line wall.
- **T D.1.5** — Tests prove the dispatch table works and `--print`
  preserves existing behavior.

### Success criteria

- All 67 existing tests still pass.
- A `manual` provider handoff still prints the full prompt (back-compat).
- A `--print` flag forces print on every provider.

---

## Phase D.2 — Move `--to` providers behind the table without breaking them

### Tasks

- **T D.2.1** — Every provider gets a default print launcher entry
  unless a real one is registered later. The current AGENTS.md write
  for `codex`/`omp` continues unchanged.
- **T D.2.2** — `printRepoHarnessStatus` and other status touchpoints
  remain unchanged.

### Success criteria

- `atem handoff X --to omp` and `atem handoff X --to claude-code` keep
  today's behavior (AGENTS.md write + prompt print) until D.3/D.4 land.

---

## Phase D.3 — Codex bridge launcher (the proof)

### Background

`docs/research/codex-bridge.md` confirmed Path A: Codex ships a JSON-RPC
v2 protocol with `ThreadStart` / `ThreadSetName` / `TurnStart` RPCs and
a stdio proxy entry point (`codex app-server proxy --sock`).

### Tasks

- **T D.3.1** — Empirical probe: start `codex remote-control` and watch
  framing of the first `Initialize` reply (newline-delimited vs LSP
  headers). Resolve open question #1 from the research doc.
- **T D.3.2** — `src/launchers/codex.js`:
  - `available()` checks `codex` binary + control socket path.
  - `launch()`:
    1. ensures daemon (`codex remote-control start` if not running).
    2. spawns `codex app-server proxy --sock <path>`.
    3. JSON-RPC: Initialize → ThreadStart → ThreadSetName → TurnStart.
    4. returns `{ kind: 'launched', summary }`.
- **T D.3.3** — Register in launcher table.
- **T D.3.4** — Real-world test on this machine. Confirm sidebar entry.

### Success criteria

- After `atem handoff <task> --to codex`, Codex's sidebar shows the new
  thread named `atem: <shortId>` within seconds.
- Thread's cwd matches the handoff target repo/worktree.
- First turn contains the handoff brief.

---

## Phase D.4 — Claude Code launcher

### Tasks

- **T D.4.1** — `src/launchers/claude-code.js`:
  - `available()` checks `claude` binary on PATH.
  - `launch()`:
    - For a synthetic id of the form `claude-code:<uuid>`:
      `claude --resume <uuid>` in the target cwd (resumes that session).
    - For a synthetic id from another provider:
      `claude -p "Pick up the ATEM handoff."` in the target cwd.
    - Returns `{ kind: 'launched', summary }`.
- **T D.4.2** — Register in launcher table.

### Success criteria

- Handoff to claude-code launches `claude` in the right cwd, either
  resuming the same session id or starting fresh with a primed prompt.

---

## Out of scope (explicit)

- Cursor / OmP launchers — same pattern, later sub-plans.
- Round-trip "session bridging" via MCP — long-term, not now.
- Auto-detect the *next* provider — `--to` stays explicit.

---

## Execution order

```
D.1.1 → D.1.2 → D.1.3 → D.1.4 → D.1.5         (scaffolding)
                    ↘ D.2.1                    (regression-free)
D.3.1 → D.3.2 → D.3.3 → D.3.4                  (Codex bridge)
D.4.1 → D.4.2                                  (claude-code)
```

Commits: one per phase, atomic.
