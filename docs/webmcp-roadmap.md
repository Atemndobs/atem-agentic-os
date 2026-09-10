# ATEM WebMCP roadmap

Date: 2026-09-10
Status: Approved for research spike
Priority: Strategically high
Task ID: TASK-WEBMCP-ATEM-001
Related task: TASK-WEBMCP-AGENTIC-DEV-001

## Strategic fit

ATEM has two roles in the WebMCP roadmap:

1. Provide structured tools for ATEM's own local planning viewer.
2. Own the reusable agentic-development contract adopted by web application repositories.

The second role addresses an immediate engineering cost: coding agents repeatedly inspect screenshots, discover DOM structure, construct selectors, and script interactions to reproduce and verify UI changes. A development-only WebMCP catalogue can expose those capabilities semantically while production keeps a separate narrow allowlist.

ATEM remains a local-first, provider-neutral continuity layer. WebMCP does not make ATEM an execution runtime, cloud service, or autonomous agent.

Specifications:

- [Agentic Development Contract](./webmcp-agentic-development-contract.md)
- This document defines ATEM's own local viewer integration.

Primary references:

- https://github.com/webmachinelearning/webmcp
- https://developer.chrome.com/blog/webmcp-epp

## Operating modes

The shared contract defines off, development, and production modes.

For the ATEM repository:

- off is the default.
- development exposes the full viewer-development catalogue against local fixture/session roots.
- production is not currently applicable because atem web is a local viewer, but the registry separation must still be implemented so the reference pattern is valid for adopting applications.

Mode is server-derived. Browser controls may disable tools but cannot enable development mode.

## ATEM local viewer tools

| Tool | Type | Behavior |
| --- | --- | --- |
| list-atem-tasks | read | Return bounded active and recent tasks with status, provider, type, and repository |
| get-task-context | read | Return the canonical brief, state, next steps, decisions, and validation summary |
| search-planning-docs | read | Search indexed planning documents with repository and document locators |
| compare-task-snapshots | read | Return a bounded semantic or file-level comparison between snapshots |
| get-viewer-page-contract | development | Return the active viewer route, states, actions, invariants, and source locators |
| load-viewer-test-scenario | development | Load an isolated viewer fixture |
| reset-viewer-test-scenario | development | Reset the isolated fixture deterministically |
| get-viewer-state | development | Return active selection, filters, search state, errors, and registered components |
| navigate-viewer | development | Navigate using the viewer's own router |
| check-viewer-overflow | development | Evaluate registered surfaces at approved viewport sizes |
| run-viewer-accessibility-check | development | Run the approved accessibility checks |
| prepare-handoff | prepare | Validate provider and repository and show a proposed handoff without executing it |

No tool may execute shell commands, write files, launch providers, change routes, mutate repositories, or execute a handoff in the first implementation.

## Architecture

- Keep the existing viewer server and ATEM session files authoritative.
- Implement the shared compatibility, mode, registry, result-envelope, audit, and page-contract interfaces.
- Use existing ATEM resolvers and pure validation functions.
- Do not read arbitrary paths supplied by a caller.
- Resolve task IDs, repository paths, artifacts, and snapshots through existing allowlists.
- Register only route-relevant tools and unregister them on navigation or shutdown.
- Synchronize the visible viewer selection with successful tool calls.
- Support cancellation for search and comparison work.
- Disable cross-origin exposure.

## Local security

- Bind to localhost using existing viewer rules.
- Development fixtures use explicit temporary roots.
- Treat planning documents, session text, tool descriptions, and tool results as untrusted.
- Never interpret document text as permission to invoke another tool.
- Redact environment variables, credentials, provider tokens, and paths outside approved roots.
- Log bounded local audit metadata without retaining full prompts or documents.
- A WebMCP call gains no authority beyond the existing viewer server and repository boundary.

## Compatibility

- Use document.modelContext only after feature detection.
- Isolate draft API changes inside the compatibility adapter.
- Record the tested browser build and WebMCP draft revision.
- If the API is absent or changes, atem web works unchanged.
- The stdio MCP server remains the supported provider integration.
- The shared contract remains usable by applications without an ATEM daemon.

## Evaluation

Test:

- unsupported-browser and off-mode fallback
- dynamic registration by route and mode
- path traversal and unknown task rejection
- cross-repository boundary refusal
- malicious instructions embedded in planning text
- isolated fixture loading and deterministic reset
- cancellation
- navigation cleanup
- visible-state synchronization
- prepare-handoff cannot execute
- no network, cloud state, or telemetry introduced

Compare structured tool use with DOM-based viewer navigation for completion, wrong selections, steps, screenshots, retries, latency, and context size.

## Delivery sequence

1. Complete TASK-WEBMCP-AGENTIC-DEV-001 contract version 0.1.
2. Add a disabled compatibility adapter and test doubles.
3. Implement server-derived mode and separate registries.
4. Instrument the ATEM viewer with page contracts.
5. Implement task, context, search, and snapshot reads.
6. Add viewer scenario, semantic-state, navigation, overflow, and accessibility tools.
7. Add prepare-handoff as a visible non-executing preview.
8. Run adversarial boundary and prompt-injection tests.
9. Integrate the contract into Ops Central as the first application reference.
10. Benchmark at least three real Ops Central UI tasks.
11. Refine installation guidance before RAP adoption.

## Acceptance criteria

- The default install and existing viewer behavior do not change.
- No WebMCP path runs when unsupported or disabled.
- All access uses ATEM resolvers and approved roots.
- Agents can operate instrumented viewer workflows without arbitrary selectors.
- Tool output identifies its task, repository, page, and evidence.
- Viewer state and tool results remain synchronized.
- Fixture tools cannot address real session roots unless explicitly configured for read-only use.
- prepare-handoff never writes state or launches a provider.
- Tests prove traversal, boundary, malicious-content, and mode-isolation refusals.
- The work adds no cloud service, telemetry, or background daemon.

## Promotion gate

Any state mutation or handoff execution requires a separate capability-and-confirmation design after browser support, isolation, and the read/prepare pilot are proven.
