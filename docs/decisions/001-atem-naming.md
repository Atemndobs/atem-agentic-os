# ADR-001: ATEM stands for Agent Task Execution Mesh

> Date: 2026-06-03 (immediately post-v0.1.0)
> Status: Accepted
> Replaces: nothing (first official definition)

## Context

Through v0.1.0, ATEM existed as a product name without a documented
acronym expansion. The codebase used `PRODUCT_NAME = 'ATEM'` and a
tagline ("Session handoff for AI coding agents, backed by Git") but no
file ever defined what the four letters stood for.

Two informal interpretations were considered before v0.1.0:

1. **"It's just my first name"** (Atem Ndobegang — the author).
   Pure pragmatism; no semantic claim.

2. **"Agent Task Execution Memory"** (early backronym).
   Captured one half of the system — preserving context across
   sessions — but didn't describe the rest.

Reviewing what actually shipped in v0.1.0 — 6 provider adapters, 4
real launchers, an MCP server, an installer, an `atem://` URL scheme,
a handle farm, recovery commands, and the universal-handoff
contract — *the system does more than remember.*

It connects multiple execution environments through a shared handoff
protocol. That is a mesh, not a memory.

## Decision

> **ATEM = Agent Task Execution Mesh.**

| Letter | Meaning | Why |
| --- | --- | --- |
| **A** | Agent | AI coding agents (and human-assisted sessions) are the participants |
| **T** | Task | Every workflow centers on a concrete task / session id |
| **E** | Execution | Work happens inside *external* providers, not inside ATEM |
| **M** | Mesh | ATEM connects those execution providers through a shared handoff layer |

### Official definition

> ATEM is the Agent Task Execution Mesh behind HandoffOS: a local,
> file-backed handoff layer that connects AI coding agents across
> providers while preserving task state, decisions, validation, and
> next steps.

### Short form

> ATEM = Agent Task Execution Mesh — a local handoff layer that lets
> AI coding agents continue each other's work across providers.

### Positioning hierarchy

```
HandoffOS = product concept / public positioning
ATEM      = engine / CLI / implementation
```

Preferred phrasing in marketing / docs:

> *HandoffOS is powered by ATEM: the Agent Task Execution Mesh.*

or, more compactly:

> *ATEM is the execution mesh behind HandoffOS.*

## Rationale

**Why "Mesh" beats "Memory"** for a system that already ships
provider adapters, distillers, launchers, an MCP server, an installer,
handoff commands, local session files, provider-native state
ingestion, and cross-provider continuation:

- *Memory* captures *one* of the system's jobs (preserving context).
- *Mesh* captures the *whole* system: connecting Claude Code, Claude
  Desktop, Codex, Cursor, OpenCode, omp, and Antigravity into a shared
  handoff protocol.
- The thesis already states the position: *"instead of standardizing
  execution, ATEM standardizes the handoff between executors."* That
  is literally a mesh.

**Why "Execution" instead of "Exchange" or "Transfer":**

Execution names the *boundary* the mesh sits at. ATEM is not the
executor — providers execute. ATEM mediates between executors. The
word "Execution" in the acronym names the layer ATEM sits *next* to.

## Consequences

- README.md tagline and intro paragraph updated to reflect the new
  definition.
- `src/cli.js` `PRODUCT_TAGLINE` updated to
  `"Agent Task Execution Mesh — session handoff for AI coding agents."`
- This ADR added at `docs/decisions/001-atem-naming.md` (also
  bootstraps the `docs/decisions/` directory, which the recovery
  module's project-context auto-discovery already scans).
- Future writing (blog posts, docs, install scripts) should expand
  ATEM as "Agent Task Execution Mesh" on first mention and use ATEM
  as a proper noun thereafter.
- No backwards-incompatible CLI changes. `atem` remains the binary
  name, `PRODUCT_NAME` remains "ATEM".
