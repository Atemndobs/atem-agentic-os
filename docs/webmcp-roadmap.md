# ATEM WebMCP roadmap

Date: 2026-09-10
Status: Approved for research spike
Priority: Strategically high
Task ID: TASK-WEBMCP-ATEM-001

## Strategic fit

ATEM already exposes provider-neutral task continuity through files, CLI commands, a local planning viewer, and a backend MCP server. WebMCP can make the active local browser surface agent-readable without DOM scraping while preserving ATEM as the source of continuity.

This is a browser adapter, not a new orchestration runtime. It complements the existing stdio MCP server and must not create cloud state, telemetry, or autonomous execution.

WebMCP is an evolving early-preview web standard. The adapter must be capability-detected and optional.

Primary references:

- https://github.com/webmachinelearning/webmcp
- https://developer.chrome.com/blog/webmcp-epp

## Pilot outcome

When atem web is open on localhost in a compatible browser, a browser agent can inspect active ATEM tasks, read one task's approved context, search planning documents, and prepare a handoff plan. The visible viewer reflects the same selected task and evidence.

## V1 tools

| Tool | Type | Behavior |
| --- | --- | --- |
| list-atem-tasks | read | Return bounded active and recent tasks with status, provider, type, and repository |
| get-task-context | read | Return the canonical brief, state, next steps, decisions, and validation summary for one task |
| search-planning-docs | read | Search indexed planning documents with repository and document locators |
| compare-task-snapshots | read | Return a bounded semantic or file-level comparison between two recorded snapshots |
| prepare-handoff | prepare | Validate destination provider and repository, show the proposed handoff in the UI, and require the user to execute it manually |

Do not expose direct command execution, file writes, provider launch, route changes, repository mutation, shell access, or handoff execution in V1.

## Architecture

Add a WebMCP adapter to the existing local web viewer.

- The viewer's current server and session files remain authoritative.
- WebMCP callbacks reuse existing read services and pure validation functions.
- The adapter must not read arbitrary paths supplied by a tool caller.
- Task IDs, repository paths, artifact names, and snapshot IDs are resolved through existing ATEM allowlists and URL rules.
- Register only tools relevant to the current view and unregister them on navigation or shutdown.
- Return compact structured results with stable IDs and local viewer links.
- Update the visible task selection when a read or prepare tool succeeds.
- Support cancellation for search and comparison work where possible.
- No cross-origin tool exposure in V1.

## Local security model

- Bind to localhost using the existing viewer rules.
- Treat planning documents, session text, tool descriptions, and tool results as untrusted content.
- Never interpret document text as authorization to execute another tool.
- Redact environment variables, credentials, provider tokens, and paths outside approved roots.
- Enforce repository boundaries in code at invocation time.
- Log bounded audit metadata locally: timestamp, tool, task ID, result class, and caller origin when available.
- Do not retain full prompts or document bodies in the invocation log.

## Compatibility

- Use document.modelContext only after feature detection.
- Keep a small compatibility module so API changes are isolated.
- Pin the tested browser build and WebMCP draft revision in the experiment manifest.
- If the API is absent or changes, the existing atem web viewer works unchanged.
- The existing stdio MCP tools remain the supported provider integration.

## Evaluation

Test at least:

- unsupported browser fallback
- correct dynamic registration by route
- path traversal and unknown task rejection
- cross-repository boundary refusal
- malicious instructions embedded in planning text
- cancellation
- logout is not applicable because the viewer is local, but closing or navigating removes tools
- visible UI selection stays synchronized
- prepare-handoff cannot execute a handoff
- no network or telemetry is introduced

Compare WebMCP tool use with DOM-based browser navigation for task completion, wrong selections, steps, latency, and context size.

## Delivery slices

1. Record tested draft revision and browser implementation status.
2. Add a disabled compatibility adapter with unit-test mocks.
3. Implement list-atem-tasks and get-task-context.
4. Add planning search and snapshot comparison.
5. Add prepare-handoff as a visible, non-executing preview.
6. Run adversarial boundary and prompt-injection tests.
7. Run a local user study across at least three real tasks.
8. Decide whether to retain, revise, or remove the adapter.

## Acceptance criteria

- The default install and existing viewer behavior do not change.
- No WebMCP code path runs when unsupported or disabled.
- All file access uses existing ATEM resolvers and approved roots.
- The agent sees only a small page-relevant toolset.
- Tool output identifies its source task and repository.
- The visible viewer and returned result refer to the same active task.
- prepare-handoff never writes state or launches a provider.
- Tests prove traversal, boundary, and malicious-content refusals.
- The spike adds no cloud service, telemetry, or background daemon.

## Promotion gate

Mutation or handoff execution may be considered only after the read-only pilot is reproducible, browser support is stable enough for CI, and a separate capability-and-confirmation design is approved.
