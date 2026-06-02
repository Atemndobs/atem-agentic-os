# Sub-Plan: Universal Handoff — Skill Everywhere + Plan Context

> Parent: `docs/action-plan.md` — extends Workstream 3 (adapters) and
> Workstream 1 (task intent) toward the "session-handoff layer for any
> provider" core thesis.
> Builds on: launcher table (D.1–D.8), `atem://` URL scheme, ambient
> tasks, claude-code + codex distillers.
> Status: drafted 2026-06-02
> Phases F.1 → F.4, each independently shippable.

---

## Why this plan exists

Today's handoff is provider-aware but:

1. **The verb isn't portable.** `atem handoff` only works when you have
   a terminal. Inside Codex/Cursor/Antigravity there's no equivalent.
2. **The context is too narrow.** We ship the *task* (brief, state,
   handoff) but not the *project's purpose* or the *bigger plan*. The
   next agent sees what we did this hour, not what we're building.
3. **Per-provider install is friction.** Even if we ship a great skill
   for Claude Code, the other providers don't get it.

This sub-plan fixes all three. The right model is:

- **Data layer** is already universal (session files + `atem://` URLs).
- **Verb** becomes an MCP tool exposed by `atem mcp-server` — every
  MCP-supporting provider gets it identically.
- **Context** auto-discovers the project's purpose + plan docs and
  bundles references into the handoff.
- **Install** writes the MCP config into each provider once.

---

## Goal

> In any provider that speaks MCP, the user says "hand this off to
> codex" → the AI calls `atem.handoff({to: 'codex'})` → ATEM bundles
> the task + the project's bigger plan into the new Codex session.
> One command per machine ever (`atem install --all`) sets it up.

---

## Phase F.1 — Project context auto-discovery

### What

Today's handoff prompt links 7 session files. Add a "Project context"
section that auto-discovers and lists:

- **Purpose** — `PROJECT.md`, `docs/action-plan.md`, `ROADMAP.md`,
  `VISION.md` (first match wins)
- **Plans** — `docs/sub-plan-*.md`, `PLAN.md`, `.planning/*.md`,
  newest 3 by mtime
- **Research** — `docs/research/**/*.md`, newest 3 by mtime
- **Decisions** — `ADR/*.md`, `adr/*.md`, `docs/decisions/*.md`,
  `.planning/decisions/*.md`, newest 5 by mtime

The next provider reads them with its own file-read tool. We don't
inline contents (would blow context budgets) — we list paths so the
provider fetches selectively.

### Tasks

- **T F.1.1** — `src/context.js` with `discoverProjectContext(repoRoot)`
  pure function that returns `{ purpose, plans[], research[], decisions[] }`.
- **T F.1.2** — Extend `buildHandoffPrompt` to include a `## Project
  Context` section when discovery returns any docs.
- **T F.1.3** — Tests: synthetic repos with each kind of doc;
  verify discovery + prompt formatting.

### Success criteria

- `atem handoff <task> --to codex --repo <repo-with-action-plan> --print`
  includes a Project Context block listing `docs/action-plan.md` and
  any sub-plans.
- All existing tests pass.

---

## Phase F.2 — `atem mcp-server`

### What

A stdio MCP server that exposes ATEM's verbs as MCP tools. Every
MCP-supporting provider (Claude Code, Codex, Cursor, Cline, OpenCode)
auto-discovers it once configured.

### Tasks

- **T F.2.1** — Add `@modelcontextprotocol/sdk` (or hand-roll if we
  want zero deps; the protocol is well-documented).
- **T F.2.2** — `src/mcp-server.js` registers tools:
  - `atem_handoff({ task, to, repo? })` — calls the launcher table
  - `atem_status({ repo? })` — returns the detected sessions table
  - `atem_resolve({ url })` — dereferences `atem://...`
  - `atem_adopt({ syntheticId, name? })` — promotes synthetic to alias
  - `atem_ingest_omp({ task, cwd? })` — pulls omp state
- **T F.2.3** — `atem mcp-server` CLI subcommand boots it on stdio.
- **T F.2.4** — Tests: tool registration, schema validation,
  protocol-level handshake.

### Success criteria

- `atem mcp-server` boots, responds to `tools/list`, executes
  `tools/call` for handoff against a fake task.
- Claude Code with `~/.claude/mcp.json` pointing at `atem mcp-server`
  can call `atem_handoff` end-to-end.

---

## Phase F.3 — `atem install <provider>`

### What

Idempotent installer that writes the MCP config to each provider's
expected location.

### Tasks

- **T F.3.1** — Per-provider config writers:
  - `claude-code` → `~/.claude/mcp.json` (merge into `mcpServers`)
  - `codex` → `~/.codex/mcp.json` or `~/.codex/config.toml` mcp section
  - `cursor` → `~/.cursor/mcp.json` (global) or `.cursor/mcp.json`
    (per-project; flag `--project` switches)
  - `opencode` → wherever OpenCode reads MCP
  - `antigravity` → research; fallback to a Bash skill installer
- **T F.3.2** — `atem install <provider> [--project] [--dry-run]`
- **T F.3.3** — `atem install --all` runs every provider whose binary
  is detected on the machine.
- **T F.3.4** — `atem uninstall <provider>` removes the entry cleanly.
- **T F.3.5** — Tests: each provider's config gets the entry, idempotent,
  --dry-run prints planned changes without writing.

### Success criteria

- Fresh machine: `atem install --all` configures every detected
  provider in one command.
- Re-running is a no-op.

---

## Phase F.4 — Claude Code skill (offline fallback + nicer UX)

### What

Ship a `~/.claude/skills/handoff/SKILL.md` that wraps the MCP tool with
a richer prompt (so it triggers on natural language like "hand this
off") and works even if MCP isn't configured (falls back to Bash).

### Tasks

- **T F.4.1** — Write `dist/skills/claude-code/handoff/SKILL.md` with
  trigger description + instructions to call `atem_handoff` (preferring
  the MCP tool, falling back to `atem handoff` shell command).
- **T F.4.2** — `atem install claude-code --with-skill` copies the
  skill folder into `~/.claude/skills/`.
- **T F.4.3** — Test: skill file is well-formed and the install
  command actually puts it in place.

### Success criteria

- In a fresh Claude Code session, "hand this off to codex" reliably
  triggers the handoff via either MCP tool or Bash.

---

## Execution order

```
F.1.1 → F.1.2 → F.1.3                  (richer context, ships first)
                  ↘
F.2.1 → F.2.2 → F.2.3 → F.2.4          (MCP server is the verb)
                  ↘
F.3.1 → F.3.2 → F.3.3 → F.3.4 → F.3.5  (one-command install)
                  ↘
F.4.1 → F.4.2 → F.4.3                  (Claude Code skill polish)
```

Each phase commits independently. F.1 is the visible quality win in
every handoff that's already working; F.2–F.4 are the distribution.

---

## Out of scope (explicit)

- Antigravity-specific protocol research — when the user actually uses
  Antigravity, separate sub-plan.
- Replacing `atem handoff` with the MCP tool entirely. CLI stays for
  scripts, debugging, and providers that don't speak MCP.
- Provider-to-provider MCP bridging (e.g., Codex calling Claude Code's
  MCP). Out of scope; ATEM is the broker, not a passthrough.

---

## First move

T F.1.1 — `src/context.js`. Pure function over the repo's docs.
Nothing else depends on it; ships in its own commit.
