# ATEM

> **Session handoff layer for AI coding agents.**
> Hand off the same task — with full plan, decisions, and project context — between Claude Code, Codex, Cursor, OpenCode, omp, and human sessions, without losing context.

```sh
atem handoff claude-code:e34143 --to codex --repo ~/sites/foo
# ✓ codex: created thread atem: claude-code:e34143 ← codex.
#   AGENTS.md updated. Codex Desktop opened at the new thread.
```

One command. The destination AI opens already pointed at the right worktree, primed with the handoff, with the full project plan visible.

---

## Why ATEM

The bottleneck in AI engineering is no longer model quality or prompt engineering — it's **continuity across providers.** Every provider owns its own memory, conversation state, and assumptions. Switching agents kills context.

ATEM is the shared file-based contract that prevents that.

It does **not** execute work. Providers execute work.
ATEM coordinates continuity between them.

```
  Claude Code ─┐
  Codex        ├──▶ ATEM ──▶ Cursor
  Cursor       │   (session
  OpenCode     │    control
  omp          │    layer)
  Human        ─┘
```

---

## Install

```sh
git clone <this-repo>
cd atem-agentic-os
npm link              # makes `atem` available globally
atem install          # registers ATEM as an MCP server in every detected provider
```

Then restart your provider apps so they load the new MCP config.

### Provider matrix

| Provider | Detection | Distillation | Launcher | MCP installer |
| --- | :---: | :---: | :---: | :---: |
| Claude Code | ✓ | ✓ | ✓ (CLI) | ✓ |
| Claude Desktop | ✓ | — | — | ✓ |
| Codex | ✓ | ✓ (SQLite) | ✓ (JSON-RPC bridge) | ✓ |
| Cursor | ✓ | ✓ (SQLite) | ✓ (`.cursorrules`) | ✓ |
| omp | ✓ | ✓ | ✓ (`AGENTS.md`) | — |
| OpenCode | ✓ | ✓ (SQLite) | ✓ (`opencode run`) | ✓ |
| Antigravity | ✓ | — | — | ✓ |

---

## Quickstart

```sh
# 1. See what's running
atem status
# Detected sessions (3):
#  claude-code:e34143  ✓ live      ~/sites/foo
#  claude-code:05a100  · 11h ago   ~/sites/bar
#  codex:cwd-b5        ✓ live      ~/sites/foo

# 2. Hand off the current Claude Code session to Codex
atem handoff claude-code:e34143 --to codex --repo ~/sites/foo

# 3. Or use natural language inside any MCP-aware provider
#    ("hand this off to cursor") — the model calls atem_handoff
#    via the MCP server you registered with `atem install`
```

That's the whole user-facing flow.

---

## What gets carried across a handoff

Beyond the active task (brief, state, handoff, next, decisions, validation, log), ATEM auto-discovers and bundles the project's bigger picture:

```
## Project Context
### Why (project purpose)
- docs/action-plan.md
### Plans (what we're building, in order of recency)
- docs/sub-plan-handoff.md
- docs/sub-plan-status-ergonomics.md
### Research (priors and context)
- docs/research/codex-bridge.md
### Decisions (don't relitigate)
- docs/decisions/001-task-ids.md
```

Heuristics recognize: `PROJECT.md`, `ROADMAP.md`, `docs/action-plan.md`, `docs/sub-plan-*.md`, `docs/research/**/*.md`, `ADR/`, `.planning/`, etc.

---

## Command reference

### Session lifecycle

| Command | What |
| --- | --- |
| `atem init` | Initialize the harness |
| `atem start "<task>" --type <type> --repo <path>` | Create a task |
| `atem status [--repo PATH] [--all]` | Live + idle sessions, auto-scoped to cwd |
| `atem adopt <task-id> [--name <alias>]` | Promote a synthetic id to a named task |
| `atem adopt --auto` | Materialize every detected ambient session |
| `atem route <task-id> --to <provider>` | Change provider routing only |
| `atem handoff <task-id> --to <provider>` | Build prompt + launch destination |
| `atem snapshot <task-id>` | Checkpoint state.md + git diff + git patch |
| `atem snapshot-diff <task-id>` | Diff between snapshots |
| `atem close <task-id>` | Mark task complete |

### URLs + state inspection

| Command | What |
| --- | --- |
| `atem resolve atem://<task>/<artifact>` | Dereference a URL to a local path |
| `atem url list \| handles \| sync \| resolve` | Manage the symlink farm at `~/.atem/handles/` |

### Recovery (Workstream 7)

| Command | What |
| --- | --- |
| `atem recover [<task>] [--fix] [--json]` | Detect + fix issues across sessions |
| `atem rollback <task> [--list] [--to <stamp>]` | Restore session files from a snapshot |
| `atem reconcile <task> [--unify <provider>]` | Align provider state across surfaces |
| `atem doctor` | Validate harness health |
| `atem clean <task-id>` | Normalize a task's state files |
| `atem archive [<task-id>] [--broken]` | Archive completed or broken sessions |

### Universal handoff (MCP)

| Command | What |
| --- | --- |
| `atem mcp-server` | stdio MCP server with `atem_handoff`, `atem_status`, `atem_resolve`, `atem_adopt`, `atem_ingest_omp` |
| `atem install [provider\|all] [--with-skill] [--dry-run]` | Register ATEM as MCP server in detected providers |
| `atem install --list` | List supported providers and detection status |
| `atem uninstall <provider>\|all` | Clean removal |

### Provider-specific

| Command | What |
| --- | --- |
| `atem ingest-omp <task-id> [--cwd PATH \| --session-id ID \| --file PATH]` | Pull omp session state into an ATEM task |
| `atem handoff <task> --from omp` | Ingest omp before handoff |

### Project / worktree

| Command | What |
| --- | --- |
| `atem project init --repo <path>` | Initialize `<repo>/.harness/` |
| `atem project doctor` | Validate project store |
| `atem worktree start <task-id> --repo <path> --branch <name>` | Feature worktree from `origin/main` |
| `atem ready <task-id> --repo <path>` | Mark task ready-for-integration |
| `atem integrate <task-id>` | Integration checklist |

---

## State on disk

```
~/.atem/harness/                       # global store (default)
├── current-session.md                 # active task pointer
├── routing.md
├── provider-contract.md
└── sessions/
    ├── .aliases.json                  # human-name → task-id
    ├── TASK-001/
    │   ├── brief.md
    │   ├── state.md
    │   ├── handoff.md
    │   ├── next.md
    │   ├── decisions.md
    │   ├── validation.md
    │   ├── log.md
    │   └── snapshots/
    │       └── <YYYY-MM-DD-HHMM>/
    └── claude-code:e34143…/           # synthetic id (ambient task)

~/.atem/handles/                       # symlink farm
├── current → sessions/<task-id>
└── <task-id>/{state,handoff,...}.md   # symlinks for providers that
                                       # only accept literal paths
```

`atem://<task-id>/<artifact>` URLs resolve through `~/.atem/handles/`.

`ATEM_HARNESS_MODE=repo` switches to per-repo `<repo>/.harness/`.

---

## How handoff works (under the hood)

1. **Build prompt** from session files + auto-discovered project context.
2. **Write `AGENTS.md`** (or `.cursorrules`) at the target repo's root — destination providers read it natively on first turn.
3. **Launch the destination** via the per-provider launcher:
   - Codex: JSON-RPC over `codex app-server --listen stdio://` → `thread/start` + `turn/start`, detached so the model response streams in the background.
   - Claude Code: `claude --resume <uuid>` or `claude -p`
   - Cursor: `cursor --reuse-window <path>`
   - OpenCode: `opencode run "<seed>" --title "atem: <id>" --dir <path>`
   - omp: `AGENTS.md` writer (omp reads it natively)
4. **Open the destination** at the new session — via deep link, native focus, or window reuse.

`--no-respond` skips the seed turn (saves model tokens). `--print` falls back to today's prompt-on-stdout behavior. `--no-focus` skips the auto-open.

---

## Architecture

ATEM is local-first, file-based, and provider-neutral.

- **Data layer**: markdown session files + SQLite for index-only data.
- **Adapter layer**: per-provider distillers (read) and launchers (write).
- **Universal verb**: `atem mcp-server` exposes the same tools (`atem_handoff`, `atem_status`, ...) to every MCP-aware provider.
- **No server**, no daemon (besides `codex-runner` which self-terminates after one turn).
- **No cloud**, no telemetry.

164 tests cover the contract end-to-end.

---

## What ATEM does NOT do

- Execute work — providers do that.
- Replace your IDE — your editor is still your editor.
- Run autonomous agents — every handoff is human-initiated.
- Phone home — everything is local.
- Cloud orchestration — there is no cloud.

---

## Docs

- [`docs/action-plan.md`](./docs/action-plan.md) — master roadmap (workstreams)
- [`docs/url-scheme.md`](./docs/url-scheme.md) — `atem://` URL grammar
- [`docs/research/`](./docs/research/) — per-provider storage contracts
- [`docs/sub-plan-*.md`](./docs/) — design decisions for each ship

---

## License

[MIT](./LICENSE).
