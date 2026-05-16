# **ATEM Agentic OS — Current State, Strategic Direction, and Parallel Execution Plan**

## **What We Are Building**

ATEM is a **local-first Agentic OS** focused on one problem:

Maintaining session continuity across fragmented AI coding systems.

This is not:

* an IDE
* an orchestration runtime
* a dashboard
* an autonomous agent platform

ATEM is:

A provider-neutral session control layer for AI coding workflows.

Its role is to allow:

* Claude Code
* Codex
* Cursor
* OpenCode
* OpenRouter
* local models
* human engineers

to cooperate through a shared session protocol.

---

# **The Core Insight**

The bottleneck in AI engineering has shifted.

It is no longer primarily:

* model quality
* prompt engineering
* code generation speed

The bottleneck is now:

* context continuity
* session persistence
* task intent preservation
* provider coordination
* repository boundary enforcement

Every provider currently owns its own:

* memory
* assumptions
* chat state
* workspace understanding
* handoff behavior

When switching systems:

context dies.

ATEM exists to prevent that.

---

# **The Architectural Model**

## **ATEM does NOT execute work**

Providers execute work.

ATEM coordinates continuity.

```text
Claude Code
Codex
Cursor
OpenCode
Local models
Human engineers
        │
        ▼
ATEM Session Control Layer
        │
        ▼
Shared durable session state
```

---

# **Current Architecture**

## **Shared State Root**

```text
~/.atem/harness/
```

## **Session Structure**

```text
sessions/TASK-001/

brief.md
state.md
handoff.md
decisions.md
next.md
validation.md
log.md
snapshots/
```

---

# **Core Contract**

Every provider follows the same contract.

## **Before working**

Read session files.

## **Before stopping**

Update session files.

This is the foundation of the entire system.

---

# **What Has Already Been Built**

## **1. Provider Detection**

```bash
atem status
```

Detects active providers machine-wide:

* Claude Code
* Codex
* Cursor
* OpenCode
* OpenRouter

Purpose:

* awareness
* session attachment
* routing visibility

---

## **2. Session Adoption**

```bash
atem adopt TASK-001
```

Attaches observed provider activity to a durable task session.

Updates:

```text
state.md
```

with:

* repositories
* workspaces
* active providers

---

## **3. Idempotent State Updates**

Repeated adoption no longer duplicates provider blocks.

This was critical because:

session files are the source of truth

State drift destroys reliability.

---

## **4. Health Validation**

```bash
atem doctor
```

Checks:

* harness integrity
* required files
* duplicate provider blocks
* malformed state
* invalid providers
* Codex workspace consistency

This became the operational guardrail.

---

## **5. Session Cleanup**

```bash
atem clean TASK-001
```

Normalizes:

* duplicate sections
* malformed markdown
* repeated providers
* broken structure

Purpose:

* repair corrupted sessions
* maintain deterministic structure

---

## **6. Provider Instructions**

```bash
atem instructions claude-code
```

Generates provider-specific operating contracts.

Examples:

* CLAUDE.md
* AGENTS.md
* .cursorrules
* Codex instructions

Purpose:

make providers obey the session protocol

---

## **7. Handoff Prompt Generation**

```bash
atem handoff TASK-001 --to codex
```

Generates:

* task context
* repository boundaries
* files to read
* files to update
* operational constraints

This is the current session transfer mechanism.

---

## **8. Repository Boundary Enforcement**

Providers are explicitly restricted to:

* target repository
* assigned worktree
* active session files

This prevents:

* cross-project contamination
* accidental edits
* workspace drift

Critical for multi-repo environments.

---

## **9. Structured Notes & Decisions**

```bash
atem note TASK-001 ...
```

Updates:

* log.md
* decisions.md
* next.md
* validation.md

Purpose:

* preserve reasoning
* preserve intent
* preserve operational continuity

---

## **10. Explicit Routing**

```bash
atem route TASK-001 --to codex
```

Separates:

* routing state

  from:
* handoff generation

This created cleaner architecture boundaries.

---

## **11. Git Snapshots**

```bash
atem snapshot TASK-001
```

Captures:

* git status
* diff summary
* patch
* session state
* validation state

Purpose:

checkpoint continuity between providers

---

# **What the Live Test Revealed**

The first real provider loop succeeded structurally.

Providers:

* resumed correctly
* respected boundaries
* updated state
* passed validation

But the test exposed a deeper issue:

## **The task had unclear intent**

The task was:

```text
System-wide session control
```

But the repository was:

```text
opscentral-admin
```

This created ambiguity.

The provider correctly hesitated to modify code.

---

# **The Most Important Discovery So Far**

## **AI systems need structured intent**

Not just context.

This became the next major architectural requirement.

---

# **Immediate Next Priority**

# **Task Type System**

We now need typed task intent.

---

# **Task Types**

## **tracker**

Purpose:

* coordination
* documentation
* session tracking

Rules:

* no code changes unless explicitly requested

---

## **implementation**

Purpose:

* concrete code modification

Rules:

* smallest safe implementation
* bounded repository scope

---

## **investigation**

Purpose:

* inspect
* diagnose
* report

Rules:

* avoid modification unless instructed

---

## **validation**

Purpose:

* test
* verify
* audit

---

## **documentation**

Purpose:

* write docs
* improve handoff clarity
* update operational context

---

## **review**

Purpose:

* review changes
* identify risks
* produce findings

---

# **Required Changes**

## **`atem start`**

Must support:

```bash
atem start "Fix OAuth timeout" \
  --type implementation \
  --repo /path/to/repo
```

---

## **`atem doctor`**

Must validate:

* valid task type
* task/repo consistency
* implementation tasks have repos
* tracker tasks avoid accidental code routing

---

## **`atem handoff`**

Must include behavioral instructions based on task type.

Example:

## **Tracker**

```text
Do not modify application code.
Update session notes only.
```

## **Implementation**

```text
Make the minimal change required.
```

---

## **`atem clean`**

Must normalize task-type structure.

---

# **Parallel Workstreams (IMPORTANT)**

The following can now be developed in parallel.

---

# **Workstream 1 — Task Intent System (Highest Priority)**

## **Deliverables**

* task type schema
* validation rules
* typed handoff templates
* doctor integration
* migration for old tasks

## **Goal**

Prevent ambiguous provider behavior.

---

# **Workstream 2 — Session Schema Standardization**

## **Goal**

Formalize deterministic structure.

Define:

* canonical markdown layout
* section ordering
* metadata rules
* machine-readable headers

Potential future:

```yaml
---
task_type: implementation
provider: codex
repo: ...
---
```

This enables:

* automation
* parsers
* future orchestration

---

# **Workstream 3 — Provider Adapter Layer**

Current system is prompt-driven.

Next step:

Create lightweight adapters for:

* Claude Code
* Codex
* Cursor
* OpenCode

Responsibilities:

* read ATEM state
* update ATEM state
* standardize lifecycle behavior

NOT autonomous execution.

Still human-driven.

---

# **Workstream 4 — Snapshot Intelligence**

Current snapshots are raw.

Next:

Add:

* semantic change summaries
* provider-to-provider diff summaries
* reasoning extraction
* session replay capability

Goal:

reconstruct provider transitions over time

---

# **Workstream 5 — Session Graph & Routing Model**

Build internal graph model:

```text
Provider A
   ↓
snapshot
   ↓
Provider B
   ↓
validation
```

Goal:

* session lineage
* replayability
* auditability

---

# **Workstream 6 — Multi-Repo Awareness**

Needed for:

* worktrees
* monorepos
* cross-service changes

Add:

* repo identity
* workspace ownership
* dependency awareness

---

# **Workstream 7 — Failure Recovery**

Add recovery mechanics for:

* incomplete handoffs
* abandoned sessions
* conflicting provider state
* corrupted markdown

Potential commands:

```bash
atem recover
atem rollback
atem reconcile
```

---

# **What We Should NOT Build Yet**

Do NOT build:

* dashboards
* cloud orchestration
* Temporal workflows
* autonomous agents
* model benchmarking
* SaaS infrastructure
* background execution systems
* centralized hosted platform

Those are premature.

---

# **Current Product Definition**

ATEM is currently:

A local-first Agentic OS for session continuity across AI coding systems.

Its job:

* preserve context
* preserve reasoning
* preserve intent
* standardize handoffs
* enforce operational boundaries

---

# **Strategic Positioning**

The ecosystem is fragmenting.

Teams will continue using:

* multiple providers
* multiple IDEs
* local + cloud models
* frontier + low-cost models

That fragmentation is permanent.

ATEM assumes:

execution layers will remain fragmented

So instead of standardizing execution:

ATEM standardizes continuity.

---

# **Immediate MVP Validation Goal**

Run a complete real implementation loop:

```bash
atem start "Add provider handoff docs" \
  --type implementation \
  --repo /target/repo

atem route TASK-002 --to claude-code
atem handoff TASK-002

atem snapshot TASK-002

atem route TASK-002 --to codex
atem handoff TASK-002

atem snapshot TASK-002

atem doctor
```

Success criteria:

* continuity preserved
* repo boundaries respected
* task intent obeyed
* state remained deterministic
* handoff remained understandable

If this succeeds:

the core MVP is validated.
