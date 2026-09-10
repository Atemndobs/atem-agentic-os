# WebMCP Agentic Development Contract

Date: 2026-09-10
Status: Approved for specification and reference implementation
Priority: Strategically high
Task ID: TASK-WEBMCP-AGENTIC-DEV-001

## Purpose

Define one reusable contract that lets coding agents inspect, operate, and verify running web applications through structured tools instead of repeatedly reconstructing the UI through screenshots, selectors, and DOM scripting.

ATEM owns the provider-neutral contract, compatibility boundary, installation guidance, and validation rules. Each application owns its routes, page contracts, fixtures, domain actions, authorization, and production allowlist.

This contract complements ATEM session continuity. It does not turn ATEM into a code executor, cloud service, or autonomous agent runtime.

## Operating modes

Every adopting repository supports exactly these logical modes:

| Mode | Meaning |
| --- | --- |
| off | Register no WebMCP tools |
| development | Register the development catalogue and any production tools against isolated non-production services |
| production | Register only the repository's approved production allowlist |

The application server and build environment derive the mode. Client state may reduce exposure to off, but may never elevate production or off into development.

Invalid or missing configuration defaults to off.

## Required module boundaries

An adopting application separates:

- compatibility adapter
- shared contract types
- development registry
- production registry
- application-specific tool implementations
- audit adapter
- test harness

The production registry must not import the development registry. Development-only modules must be absent from production output rather than merely protected by a runtime branch.

ATEM may provide a small reference adapter or installable package after the contract is validated. The contract must remain usable without an ATEM daemon or cloud service.

## Standard development capabilities

Applications select relevant tools from these capability groups.

### Discovery

- list-app-routes
- get-page-contract
- get-active-environment
- get-active-identity-summary

### Semantic state

- get-visible-component-state
- get-form-state
- explain-disabled-control
- capture-ui-state
- compare-ui-state

### Navigation and interaction

- navigate-to-screen
- invoke-ui-action

These tools must use registered application actions and router functions. They may not accept arbitrary DOM selectors or JavaScript.

### Scenario control

- list-test-scenarios
- load-test-scenario
- reset-test-scenario

Scenario tools operate only on isolated local or preview data. Reset must be deterministic and idempotent.

### Diagnostics

- get-console-errors
- get-failed-requests
- get-component-source-location
- get-runtime-feature-state

Results are bounded and redact credentials, tokens, personal data, and sensitive payloads. Source locations are repository-relative and come from an allowlisted manifest.

### Verification

- run-accessibility-check
- check-responsive-overflow
- capture-visual-checkpoint
- compare-visual-checkpoints
- run-page-contract-check

Structured verification does not eliminate screenshots. Visual judgment still requires rendered evidence, but screenshots should not be the primary method for discovering state or controls.

## Page contract

Every instrumented page declares a machine-readable contract containing:

- stable page ID
- purpose
- allowed environments
- required roles or capabilities
- meaningful states
- primary actions
- registered components
- valid test scenarios
- expected invariants
- source and test locators
- sensitive fields that must never be returned

The contract describes the UI. It does not override application authorization or domain rules.

## Tool result envelope

Every shared development tool returns a common envelope:

- version
- tool name
- invocation ID
- environment
- repository ID
- page ID
- status: success, validation_error, forbidden, unavailable, failed
- concise summary
- bounded structured data
- visible-state change, if any
- repository-relative evidence locators
- retryable flag
- timestamp

Errors must be actionable without exposing sensitive internals.

## Security invariants

- WebMCP mode is decided by trusted server/build configuration.
- Development mode cannot be activated through query parameters, local storage, cookies, browser-console commands, or client-supplied headers.
- Development tools cannot address production data, credentials, identity providers, or mutation endpoints.
- Application authorization is checked again when each tool executes.
- Tool descriptions, page text, fixtures, and results are untrusted content and cannot grant capabilities.
- Arbitrary DOM selection, script execution, network destinations, database queries, paths, shell commands, and file writes are prohibited.
- Cross-origin exposure is disabled in the initial reference implementation.
- Audit records contain bounded metadata, not full prompts, source documents, personal data, or secrets.

## Production separation contract

A repository may implement production WebMCP, but it is independent from the development catalogue.

Production requirements:

- explicit tool-name allowlist
- route, role, capability, and current-state filtering
- no development introspection or scenario tools
- no debug traces or source locations
- safe result redaction
- visible UI synchronization
- separate approval for mutations
- default off
- independent activation and rollback

A development tool becoming useful to customers does not automatically promote it. It requires a new production specification and review.

## Installation model

The first reference implementation should support:

1. installing shared types and the compatibility adapter
2. generating empty development and production registries
3. generating a page-contract template
4. adding CI tests for environment isolation and production bundle inspection
5. adding ATEM project guidance so coding providers know how to use the tools
6. recording the tested browser build and WebMCP draft revision

Future repositories should receive this structure during project initialization once the reference implementation is proven.

## ATEM integration

ATEM task context may advertise that a repository has a WebMCP development interface and where its usage guide lives.

A handoff may include:

- development URL
- required non-production environment
- named test scenario
- expected page contract
- approved WebMCP mode
- validation commands
- evidence to capture

ATEM must not enable development mode, mint application credentials, or bypass the repository's controls.

## Agentic-development measurement

Compare the same representative implementation task with and without the structured development interface.

Capture:

- time to reproduce the target state
- browser and DOM operations
- screenshots required
- failed selectors and retries
- WebMCP tool calls
- input and output tokens
- time from patch to verified result
- regressions caught before review
- reviewer corrections and minutes
- Production-Qualified Change outcome

Use at least three tasks across at least two meaningful UI workflows before claiming a general cost or productivity improvement.

## Reference implementation sequence

1. Freeze contract version 0.1 and browser compatibility assumptions.
2. Implement the compatibility adapter with test doubles.
3. Implement mode resolution and registry lifecycle.
4. Implement page-contract discovery and semantic-state tools.
5. Implement navigation and registered UI-action tools.
6. Implement isolated scenario controls.
7. Implement bounded diagnostics and verification adapters.
8. Add production bundle and endpoint isolation tests.
9. Integrate the reference implementation into Ops Central.
10. Benchmark three Ops Central UI tasks.
11. Incorporate lessons and publish installation guidance.
12. Transfer the refined contract to RAP after its repository is confirmed.

## Acceptance criteria

- An adopting app can use the contract without running an ATEM daemon.
- Unsupported browsers and off mode leave the app unchanged.
- Development mode cannot address production services.
- Production artifacts contain no development registry or prohibited tool identifiers.
- Agents can operate registered workflows without arbitrary selectors.
- Page contracts remain synchronized with their source and tests through CI.
- Audit output is bounded and redacted.
- ATEM handoffs can name a development scenario without granting new authority.
- Measurements compare against a documented DOM-driven baseline.
- The reference implementation can be removed without changing application domain logic.

## Non-goals

- Source-code editing through WebMCP
- Arbitrary browser automation
- Replacing Playwright or visual review
- Remote cloud execution
- Production debugging backdoors
- Automatic promotion of development tools
- Autonomous deployment or repository mutation
