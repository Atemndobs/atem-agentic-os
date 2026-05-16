# Build Brief: Git-Based Session Routing Control for Coding Agents

## 1. Problem Statement

We currently use multiple AI coding providers and IDE/tooling environments, including Cursor, Claude Code, Codex, OpenCode, OpenRouter/local models, and Antigravity-like environments.

Each provider has its own session state, chat history, model behavior, context handling, and workflow style. When switching from one provider or IDE to another, the active task context is lost or becomes fragmented. This forces the user to manually explain the same task again, remember previous decisions, decide which model/provider should continue, and reconstruct the current state of work.

The problem is not that we need a new IDE, dashboard, or full orchestration platform. The core problem is:

> We need a simple, provider-neutral way for each coding agent/provider to hand over the current task session to the next provider through git-readable files.

The goal is to create a lightweight session routing control layer that lives inside or alongside the repository and allows any provider to continue the same task by reading a standard handoff file and updating it before stopping.

## 2. Design Principle

The harness should be simple and file-based.

Providers should continue using their native strengths:

- Cursor remains useful for IDE-native edits.
- Claude Code remains useful for reasoning and terminal-based coding.
- Codex remains useful for agentic coding loops, file edits, and validation.
- OpenCode/OpenRouter/local models remain useful for cheaper or open-source model workflows.

The harness should not try to replace these tools.

Instead, the harness should define a common contract:

> Before starting work, every provider reads the current session files.
> Before stopping work, every provider updates the session files.

This creates continuity without needing to integrate deeply with every provider API.

## 3. What We Are Building

We are building a minimal command-line tool and repository folder structure called `.harness/`.

The `.harness/` directory stores durable, human-readable, agent-readable task state.

Example structure:

```text
.harness/
├── current-session.md
├── routing.md
├── provider-contract.md
└── sessions/
    └── TASK-001/
        ├── brief.md
        ├── state.md
        ├── handoff.md
        ├── decisions.md
        ├── next.md
        ├── validation.md
        └── log.md
```

The most important file is:

```text
.harness/sessions/<TASK-ID>/handoff.md
```

This is the file every provider must read before continuing and update before stopping.

## 4. Non-Goals

Do not build these in the MVP:

- Custom IDE
- Full dashboard
- Temporal workflow orchestration
- Deep provider API integrations
- Complex multi-agent autonomy
- Automatic background coding platform
- Full model benchmarking system
- Centralized cloud control plane
- Complex vector memory system

The MVP should be local, simple, git-readable, and easy for any coding agent to use.

## 5. Three-Phase Solution Design

---

# Phase 1: Git-Based Session Handoff MVP

## Goal

Create the minimal `.harness/` folder structure and CLI commands required to start, route, continue, and close coding sessions across multiple providers.

## Required Features

### 1. Initialize harness

Command:

```bash
harness init
```

Creates:

```text
.harness/
├── current-session.md
├── routing.md
├── provider-contract.md
└── sessions/
```

### 2. Start a new task/session

Command:

```bash
harness start "Fix OAuth callback timeout"
```

Creates a new task folder:

```text
.harness/sessions/TASK-001/
```

Files created:

```text
brief.md
state.md
handoff.md
decisions.md
next.md
validation.md
log.md
```

### 3. Route a task to a provider

Command:

```bash
harness route TASK-001 --to claude-code
```

Updates:

```text
.harness/current-session.md
.harness/sessions/TASK-001/handoff.md
.harness/sessions/TASK-001/log.md
```

Supported provider names for MVP:

```text
cursor
claude-code
codex
opencode
openrouter
local-model
manual
```

### 4. Show current session

Command:

```bash
harness status
```

Prints:

- current task ID
- current provider
- goal
- current status
- next recommended step
- files touched
- validation status

### 5. Generate provider handoff prompt

Command:

```bash
harness handoff TASK-001
```

Prints a copy-paste-ready prompt that can be pasted into Claude Code, Codex, Cursor, OpenCode, or another provider.

### 6. Close a task

Command:

```bash
harness close TASK-001
```

Marks the task complete in `state.md` and appends to `log.md`.

## Phase 1 Success Criteria

Phase 1 is successful when:

- A task can be started from the CLI.
- A `.harness/sessions/TASK-ID/` folder is created.
- A provider can read `handoff.md`.
- A provider can update `handoff.md`.
- The user can route the task from one provider to another.
- The user can continue the same work in another IDE/tool by reading the handoff file.
- No database is required.
- No cloud service is required.

---

# Phase 2: Routing Control and Provider Contracts

## Goal

Make provider handoff more reliable by adding routing rules, standard provider instructions, and validation discipline.

## Required Features

### 1. Routing policy file

Create or update:

```text
.harness/routing.md
```

Example content:

```markdown
# Routing Policy

## Provider Defaults

| Task Type | Preferred Provider |
|---|---|
| Deep reasoning / architecture | claude-code |
| Test-driven implementation | codex |
| IDE-native edits | cursor |
| Cheap/simple edits | opencode or openrouter |
| Boilerplate/docs | openrouter or local-model |
| Manual review | manual |

## Rules

- If tests must be run, prefer codex or claude-code.
- If the task is mostly reasoning, prefer claude-code.
- If the task is interactive editing inside the IDE, prefer cursor.
- If the task is cheap and low risk, prefer opencode/openrouter/local-model.
- If the task touches auth, security, payments, infrastructure, or migrations, require validation and human review.
```

### 2. Provider contract file

Create:

```text
.harness/provider-contract.md
```

Content:

```markdown
# Provider Contract

You are continuing an existing coding task.

Before working:

1. Read `.harness/current-session.md`.
2. Read the active session's `brief.md`.
3. Read the active session's `state.md`.
4. Read the active session's `handoff.md`.
5. Read the active session's `next.md`.
6. Follow `.harness/routing.md`.

While working:

1. Prefer small, reviewable changes.
2. Keep task scope narrow.
3. Record important decisions in `decisions.md`.
4. Record commands and validation results in `validation.md`.
5. Do not overwrite prior session context unless it is clearly obsolete.
6. Preserve existing user intent and constraints.

Before stopping:

1. Update `handoff.md`.
2. Update `state.md`.
3. Update `next.md`.
4. Update `validation.md`.
5. Append a short entry to `log.md`.

Never end a session without updating the handoff.
```

### 3. Generate provider-specific instruction snippets

Command:

```bash
harness provider-instructions claude-code
harness provider-instructions codex
harness provider-instructions cursor
```

Each command prints a short instruction block that the user can add to:

```text
CLAUDE.md
AGENTS.md
.cursorrules
.codex/instructions.md
```

### 4. Add basic route recommendation

Command:

```bash
harness suggest TASK-001
```

Reads `brief.md`, `state.md`, `validation.md`, and `routing.md`, then recommends a provider.

MVP recommendation logic can be keyword/rule-based.

Example:

- contains "test", "failing", "debug" => codex or claude-code
- contains "architecture", "design", "reason" => claude-code
- contains "docs", "readme", "copy" => openrouter/local-model
- contains "small edit", "rename", "format" => cursor/opencode
- contains "auth", "security", "payment", "migration" => premium provider + human review

## Phase 2 Success Criteria

Phase 2 is successful when:

- The harness can recommend a provider.
- The provider contract is standardized.
- The same rules can be used in Claude Code, Codex, Cursor, and OpenCode.
- Providers reliably update the same session files.
- The user has less manual thinking when switching tools.

---

# Phase 3: Lightweight Automation and Quality Gates

## Goal

Add lightweight automation without turning the system into a complex orchestration platform.

## Required Features

### 1. Validation commands

Allow project-level validation config:

```text
.harness/validation.md
```

Example:

```markdown
# Validation Commands

## JavaScript/TypeScript
- npm test
- npm run lint
- npm run typecheck

## Python
- pytest
- ruff check .
- mypy .

## General
- git diff --check
```

Command:

```bash
harness validate TASK-001
```

Runs configured validation commands and updates:

```text
.harness/sessions/TASK-001/validation.md
```

### 2. Diff summary

Command:

```bash
harness diff TASK-001
```

Shows:

- changed files
- git diff summary
- current branch
- uncommitted changes

Also appends a summary to `state.md` or `handoff.md`.

### 3. Session checkpoint

Command:

```bash
harness checkpoint TASK-001
```

Creates a snapshot:

```text
.harness/sessions/TASK-001/checkpoints/
```

Each checkpoint contains:

```text
timestamp.md
git-status.txt
diff-summary.md
handoff.md
validation.md
```

### 4. Optional git commit support

Command:

```bash
harness commit TASK-001
```

Creates a commit using a generated message from:

- `brief.md`
- `state.md`
- `validation.md`
- git diff summary

This should be optional and require user confirmation.

## Phase 3 Success Criteria

Phase 3 is successful when:

- The user can checkpoint task progress.
- The user can run validation through the harness.
- The handoff includes current diff and test status.
- Provider switching becomes predictable and auditable.
- The system remains simple and local-first.

---

## 6. Session File Templates

### `brief.md`

```markdown
# Task Brief

## Task ID
TASK-001

## Title
Fix OAuth callback timeout

## Goal
Fix the OAuth callback timeout while preserving the existing redirect behavior.

## Scope
- Diagnose timeout cause.
- Patch the smallest necessary surface area.
- Add or update tests if needed.
- Validate the fix.

## Out of Scope
- Redesigning OAuth.
- Changing public redirect contracts.
- Changing unrelated auth flows.

## Constraints
- Preserve telemetry fields.
- Keep retry count under or equal to 3.
- Avoid large refactors.
```

### `state.md`

```markdown
# Session State

## Status
active

## Current Provider
claude-code

## Current Summary
Task started. No implementation yet.

## Files Touched
None yet.

## Known Issues
None yet.

## Last Updated
YYYY-MM-DD HH:MM
```

### `handoff.md`

```markdown
# Handoff

## Task
TASK-001 - Fix OAuth callback timeout

## Goal
Fix the OAuth callback timeout while preserving existing behavior.

## Current Status
No implementation yet.

## What Was Done
Nothing yet.

## Files Touched
None yet.

## Decisions
None yet.

## Validation
No validation run yet.

## Next Recommended Action
Diagnose the likely cause of the timeout.

## Previous Provider
None

## Next Suggested Provider
claude-code

## Reason for Suggested Provider
This task starts with diagnosis and reasoning.
```

### `decisions.md`

```markdown
# Decisions

## Decision Log

### YYYY-MM-DD HH:MM
- Decision:
- Reason:
- Impact:
```

### `next.md`

```markdown
# Next Actions

1. Read the relevant auth callback code.
2. Identify the timeout path.
3. Reproduce or locate the failing test.
4. Patch the smallest necessary surface area.
5. Run targeted validation.
```

### `validation.md`

```markdown
# Validation

## Commands Run

None yet.

## Results

No validation run yet.

## Known Failures

None yet.
```

### `log.md`

```markdown
# Session Log

## YYYY-MM-DD HH:MM
- Created TASK-001.
- Routed to claude-code.
```

---

## 7. CLI Command Specification

The CLI can be implemented in TypeScript, Python, Go, or Rust. Prefer whichever is fastest for the repository owner.

### Required commands

```bash
harness init
harness start "<task title>"
harness status
harness route <task-id> --to <provider>
harness handoff <task-id>
harness suggest <task-id>
harness close <task-id>
```

### Optional commands for Phase 3

```bash
harness validate <task-id>
harness diff <task-id>
harness checkpoint <task-id>
harness commit <task-id>
```

---

## 8. Provider Names

Use this canonical provider list:

```text
cursor
claude-code
codex
opencode
openrouter
local-model
manual
```

Reject unknown provider names unless `--allow-custom-provider` is used.

---

## 9. Implementation Requirements

### Local-first

The system must work without a server.

### Git-readable

All important state must be stored in markdown files.

### Human-readable

A human should be able to open `.harness/sessions/TASK-ID/handoff.md` and understand the task.

### Agent-readable

Any coding provider should be able to read the session files and continue.

### No lock-in

Do not depend on one provider.

### Minimal dependencies

Keep implementation small.

### Safe defaults

Do not automatically run destructive commands.

### No secrets

Do not store API keys, secrets, credentials, or sensitive tokens in `.harness/`.

---

## 10. Recommended Build Order

1. Implement folder creation with `harness init`.
2. Implement task creation with `harness start`.
3. Implement `harness status`.
4. Implement `harness route`.
5. Implement `harness handoff`.
6. Implement provider contract generation.
7. Implement `harness suggest`.
8. Implement validation/diff/checkpoint later.

---

## 11. Acceptance Tests

### Test 1: Init

Given an empty repo, when I run:

```bash
harness init
```

Then `.harness/` exists with:

```text
current-session.md
routing.md
provider-contract.md
sessions/
```

### Test 2: Start task

When I run:

```bash
harness start "Fix login bug"
```

Then a new session folder exists:

```text
.harness/sessions/TASK-001/
```

And it contains:

```text
brief.md
state.md
handoff.md
decisions.md
next.md
validation.md
log.md
```

### Test 3: Route task

When I run:

```bash
harness route TASK-001 --to codex
```

Then:

- `current-session.md` references TASK-001.
- `state.md` says current provider is codex.
- `handoff.md` says next suggested provider is codex.
- `log.md` records the routing event.

### Test 4: Handoff prompt

When I run:

```bash
harness handoff TASK-001
```

Then the CLI prints a complete prompt that can be pasted into Claude Code, Codex, Cursor, OpenCode, or another provider.

### Test 5: Close task

When I run:

```bash
harness close TASK-001
```

Then `state.md` marks the task as complete and `log.md` records closure.

---

## 12. Example Handoff Prompt Output

```markdown
You are continuing an existing coding task.

Read these files before doing any work:

1. `.harness/current-session.md`
2. `.harness/routing.md`
3. `.harness/provider-contract.md`
4. `.harness/sessions/TASK-001/brief.md`
5. `.harness/sessions/TASK-001/state.md`
6. `.harness/sessions/TASK-001/handoff.md`
7. `.harness/sessions/TASK-001/decisions.md`
8. `.harness/sessions/TASK-001/next.md`
9. `.harness/sessions/TASK-001/validation.md`

Your job:

- Continue TASK-001.
- Preserve the existing scope and decisions.
- Make the smallest useful progress.
- Update all relevant `.harness/sessions/TASK-001/` files before stopping.
- Never end the session without updating `handoff.md`.
```

---

## 13. Final Build Instruction

Build the Phase 1 MVP first.

Do not over-engineer.

The first useful version should only provide:

```text
init
start
status
route
handoff
close
```

Everything else can come later.

The main value is not automation. The main value is consistent session continuity across providers through git-readable handoff files.
