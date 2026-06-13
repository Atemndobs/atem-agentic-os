# Changelog

## Unreleased

- `atem web`: hand-off tasks now nest under the project they target
  (resolved from the task's `repo`/`target_repo`/`cwd`), shown with a
  "handoff" badge alongside that project's worktrees — there is no longer
  a standalone Tasks group. Tasks that can't be tied to an existing
  project are dropped, keeping everything contained within a project.
  The Settings "Tasks" toggle is now "Handoff tasks".
- `atem web`: interactive document reading — fenced **code blocks collapse**
  by default into a `lang · N lines` header with a Copy button (expand on
  click); **headings fold** their section (with Expand all / Collapse all);
  a **task progress bar** (`N/M done`) pins to the top of plans with
  checkboxes; and **section copy-links** (hover a heading) yield a deep link
  `#/doc/<id>/<section>` that scrolls straight to it.
- `atem web`: collapsible **Settings panel** to show/hide parts of the view —
  toggles for Tasks, worktrees, Claude memory, executed plans, and other
  (uncategorized) docs, plus hide-lists for folders, files, and projects.
  Config persists durably to `~/.atem/web-config.json` (served via
  `GET/POST /api/config`) and is mirrored into the browser for instant
  toggling; filtering is applied client-side so changes are immediate.
- `atem web`: sidebar now renders a real nested **folder tree** (date-sorted,
  newest first) instead of a flat path list; repos group their worktrees.
- `atem web`: **status color-coding** — the project's north-star doc
  (ROADMAP/PROJECT/action-plan/PLAN) is blue, the single most-recent plan/spec
  is green (active), older plans orange (executed); honors a `status:`
  frontmatter override. A dashboard "Active plans" section surfaces the green
  ones first.
- `atem web`: surfaces Claude Code's hidden per-project plans from
  `~/.claude/projects/<proj>/memory/` under a `‹claude memory›` folder.

- `atem web` — local planning viewer. Serves every agent's planning
  files as an interactive web app (`http://127.0.0.1:4400`): ATEM task
  files (brief/state/next/decisions/validation/log/handoff) plus the
  planning docs (`.planning/`, `PLAN.md`, `AGENTS.md`, sub-plans,
  research, decisions) of every project on this machine, discovered via
  the Claude Code, Codex, and ATEM registries. Zero-dependency:
  in-repo markdown renderer, hash-routed SPA, full-text search,
  fs.watch + SSE live reload. Localhost only.

## v0.1.0 — 2026-06-03

First public version. Every workstream marked as **plumbing** in the
master action plan is complete; ATEM ships as a working
session-handoff layer across six providers.

> **Naming officially recorded.** ATEM = **Agent Task Execution Mesh**.
> See [`docs/decisions/001-atem-naming.md`](./docs/decisions/001-atem-naming.md).
> Positioning: ATEM is the engine behind **HandoffOS**.

### Workstreams shipped

- **W1 — Task Intent System**: typed tasks
  (`tracker | implementation | investigation | validation |
  documentation | review`), typed handoff templates, doctor
  validation, migration command for legacy tasks.
- **W2 — Session Schema Standardization**: canonical markdown layout,
  YAML frontmatter (`task_type`, `provider`, `repo`), parsers
  re-exported for adapters.
- **W3 — Provider Adapter Layer**: full distiller + launcher for omp,
  Claude Code, Codex, Cursor, OpenCode. MCP installer for 6 providers
  (above + Claude Desktop + Antigravity).
- **W6 — Multi-Repo Awareness**: repo identity, multi-repo adapter,
  related-workspaces section, Worktree column in `atem status`.
- **W7 — Failure Recovery**: `atem recover`, `atem rollback`,
  `atem reconcile`.

### Major features

- **Ambient task identity**. Synthetic `<provider>:<session-id>` task
  ids surface every detected provider session without
  `atem start`. Aliases via `atem adopt <id> --name <alias>`.
- **Seamless handoff**. `atem handoff <task> --to <provider>` writes
  AGENTS.md / .cursorrules, opens the destination at the right
  worktree, primes the first turn. Codex bridge produces a real
  visible thread in the sidebar via JSON-RPC + targeted SQLite
  writes + Desktop deep link.
- **Universal verb**. `atem mcp-server` exposes `atem_handoff`,
  `atem_status`, `atem_resolve`, `atem_adopt`, `atem_ingest_omp` as
  MCP tools. `atem install` registers ATEM once per machine and
  every MCP-aware provider gets the same tool surface.
- **Project context bundling**. Every handoff auto-discovers
  `PROJECT.md`, `ROADMAP.md`, `docs/action-plan.md`,
  `docs/sub-plan-*.md`, `docs/research/**`, `ADR/`, `.planning/` and
  includes them in the handoff prompt.
- **`atem://` URL scheme**. Provider-agnostic addresses
  (`atem://current/handoff`, `atem://<task>/state`,
  `atem://list`). Symlink farm at `~/.atem/handles/` for providers
  that only accept literal paths.
- **Status ergonomics**. Idle detection (default 48h, configurable
  via `ATEM_RECENT_WINDOW_HOURS`), auto-scoping to current git
  repo, Worktree column, per-(provider, cwd) dedup with `N elided`
  footnote.

### Provider integrations

| Provider | Distiller | Launcher | Notes |
| --- | --- | --- | --- |
| omp | ✓ | AGENTS.md | reads from `~/.omp/agent/sessions/` |
| Claude Code | ✓ | `claude --resume` / `claude -p` | reads `~/.claude/projects/*/<id>.jsonl` |
| Codex | ✓ | JSON-RPC bridge | thread spawned via `codex app-server --listen stdio://`, runner self-terminates on `turn/completed` |
| Cursor | ✓ | `cursor --reuse-window` + `.cursorrules` | reads `~/Library/Application Support/Cursor/User/{global,workspace}Storage/state.vscdb` |
| OpenCode | ✓ | `opencode run` | reads `~/.local/share/opencode/opencode.db` |
| Claude Desktop | — | — | MCP install only |
| Antigravity | — | — | MCP install only |

### Recovery commands

- `atem recover [<task>] [--fix] [--json]` — issue detection:
  missing files, corrupted frontmatter, stale-progress (>7d),
  duplicate provider blocks, dangling aliases. Remedies are
  inline (e.g. "Archive to .archived/", "Re-sync frontmatter").
- `atem rollback <task> [--list] [--to <stamp>] [--dry-run]` —
  restore session files from a snapshot; creates a
  `pre-rollback-…` safety snapshot first.
- `atem reconcile <task> [--unify <provider>] [--json]` —
  detect drift across state.md / handoff.md /
  current-session.md / detected activity; unify with `--unify`.

### CLI quality of life

- `atem handoff --no-respond` (skip the seed turn, no model tokens).
- `atem handoff --no-focus` (don't auto-open the destination).
- `atem handoff --print` (legacy: full prompt to stdout).
- `atem install --dry-run`, `--list`, `--with-skill`.
- `atem doctor` validates harness, alias table, handle farm, codex
  AGENTS.md presence, omp sessions.

### Architecture

- Local-first. No daemon, no cloud, no telemetry.
- Markdown files + per-provider SQLite reads.
- Codex bridge spawns `codex-runner.js` detached; runner exits on
  `turn/completed` or after `ATEM_CODEX_RUNNER_MAX_MS` (default
  180s). No orphan processes.
- 164 tests cover the contract.

### Acknowledgements

Built using a multi-provider handoff loop powered by Claude Code,
Codex, and Cursor — the system was used to build itself.
