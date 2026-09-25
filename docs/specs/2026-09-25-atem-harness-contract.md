# ATEM harness contract — implementation specification

Status: Proposed for review
Date: 2026-09-25
Owner: ATEM maintainers
Target repository: Atemndobs/atem-agentic-os

## Decision and product boundary

ATEM (Agent Task Execution Mesh) is the local, provider-neutral continuity layer for human and AI coding sessions. A provider executes work; ATEM binds task intent, repository scope, decisions, evidence, and the next handoff. This specification makes that contract testable. It does not turn ATEM into an autonomous coding runtime or into the authorization layer for Ops Central business actions.

The existing README, docs/action-plan.md, docs/provider-contract.md, docs/url-scheme.md, and ADR-001 remain the source of truth for current behavior. This document proposes extensions; commands and fields below are requirements, not claims that they already ship. The existing monitor design and Convex Guard ADR are separate capabilities.

## Outcome and acceptance boundary

A task can move from Claude Code to Codex to a human and back, in an isolated worktree, without silently changing the objective or claiming unverified work. A maintainer can inspect a machine-derived handoff receipt and decide whether the work is ready for review. Preserve human-initiated handoffs and the current file-backed, local-first store.

Release acceptance is the five scenarios in the Evaluation section, passing on two supported providers, plus existing tests. No release requires an AI model to judge its own completion.

## 1. Task and workspace identity

The canonical key is task_id. A session record must identify task_type, target repository identity, worktree root when assigned, originating human request, active provider, active attempt, and state revision. A provider session ID is an observation, never a replacement for task_id. Repository identity should be canonicalized from the Git worktree common directory and remote where available; preserve an explicit local-only identity when there is no remote. Resolve and verify the worktree path before writing to it, and reject traversal or paths outside the assigned repository.

Existing Markdown artifacts remain authoritative: brief.md, state.md, handoff.md, next.md, decisions.md, validation.md, and log.md. Add a small versioned machine-readable manifest per task, for example manifest.json, as an index to those artifacts. Do not create two independent copies of the task narrative. Manifest fields: schema_version, task_id, task_type, repo_id, worktree_root, allowed_paths or explicit repo-wide scope, active_provider, active_attempt, revision, updated_at, and artifact digests. Updates to a manifest and its referenced Markdown must use a lock and an atomic replace protocol; a failed write leaves the previous complete revision readable. Repair or migrate legacy tasks in place through doctor/clean, preserving old human prose and unknown fields.

Task types retain the roadmap meanings: tracker, implementation, investigation, validation, documentation, review. Implementation requires a repository and explicit intended change; investigation/review are read-only unless the human explicitly changes scope. A handoff with mismatched task type, repository, or worktree fails before launch, with a diagnostic and no partial provider instructions written.

## 2. Handoff contract

On an explicit handoff, ATEM builds one bounded transfer packet from current task files, project context, and a snapshot of repository state. The packet contains:

- objective and success criteria from the human request;
- task type, allowed repository/worktree, and permitted operations;
- durable decisions with source artifact links;
- current state, next steps, open questions, and known failures;
- files changed and commit/dirty-state identifiers;
- validations actually run, their exit status and time, and outstanding validation;
- source revisions/digests for each included artifact.

A summary is a view over source material, not a new source of authority. If context budget is exceeded, retain the objective, constraints, recent decisions, unresolved failures, and source references first; compress old tool output and redundant history before dropping those fields. Mark omissions and provide recoverable artifact paths. Never rewrite a human instruction because a retrieved file or tool response requests it.

Handoff generation must check the task revision again immediately before it writes provider instructions. If the revision changed, rebuild once or stop with a conflict. Repeating the same handoff request with the same task revision and destination must yield the same packet identity and must not append duplicate provider or decision blocks. A new revision produces a new packet identity. Existing atem:// links and provider-specific launchers remain supported.

## 3. Tool and trust boundaries

Keep the present MCP surface limited to ATEM's own session and routing verbs. Before any ATEM MCP call, resolve an exact server/tool identity from the installed registry, validate the declared schema, bind the task and worktree, then apply the command's permission policy. Reject ambiguous names, extra arguments, unknown tool versions, or a provider-supplied path outside the task boundary. Treat repository files, tool results, and provider text as data; they may suggest an action but do not grant permission.

Permission classes: read session/status/resolve; update task artifacts; change routing/handoff; change repository files through a provider. The last class is outside ATEM's MCP authority. Explicit human initiation remains required for handoff or routing; no background monitor or retrieved text can start a provider or expand scope. Existing external adapters may keep their own authorization controls. This spec does not claim to solve downstream API exactly-once delivery.

Log decision inputs and denials without secrets or unbounded tool payloads. Redact credentials and cap retained excerpts. Do not transmit session content to a hosted evaluation service.

## 4. Evidence and completion receipt

Provide a read-only receipt generator over ATEM artifacts and local Git/test evidence. The receipt states one of ready_for_review, incomplete, blocked, or unknown, with an explanation for each unmet criterion. An agent's prose is never sufficient to set ready_for_review.

Minimum receipt fields: schema_version, task_id, task_revision, handoff_packet_id, provider attempts, repo/worktree/HEAD identifiers, changed paths, required checks, observed commands with exit status/time, unrun checks, unresolved next steps, human decisions required, and artifact references. For a documentation-only task, use documentation acceptance criteria; for implementation, require the named checks and inspectable diff. Absence of a required trace is unknown, not passed. The command can be called from CLI and MCP as a read-only view; it does not merge PRs or deploy.

Use existing snapshot and validation artifacts where possible. Add a structured evidence sidecar only where Markdown cannot reliably represent command outcome; never infer a pass from a command written in validation.md without execution evidence. A receipt is reproducible from pinned artifacts; if artifacts change, its digest changes. Distinguish a provider-reported claim from an independently observed Git or test fact.

## 5. Recovery, conflict, and operator experience

Doctor checks missing artifacts, invalid task type, broken handles, stale active provider, manifest digest mismatch, duplicate blocks, and worktree mismatch. Its default mode only reports. Clean/repair requires an explicit invocation, writes a backup, and records the repair in log.md. Recovery never silently chooses between conflicting human decisions.

At every handoff, show the operator: target provider, task type, repository/worktree, current revision, unresolved checks, and whether a new packet will be generated. A failed launch leaves task state in a recoverable pending state and does not mark the destination as having accepted work. Re-running a pending handoff either resumes the same packet or reports a revision conflict. Existing CLI behavior should remain backward-compatible unless a failure would otherwise corrupt state or cross a repository boundary.

## 6. Evaluation and gates

Freeze a small fixture set for four weekly comparisons and run the full regression suite at a phase gate. The fixture set must include:

1. Claude Code to Codex to human on a real, scoped documentation task: objective, decisions, diff, and next steps survive.
2. Two providers update the same task revision: one succeeds, the other receives a conflict; no prose or manifest data is lost.
3. A long tool log and source file containing a malicious instruction: packet preserves constraints and treats the text as untrusted, with omission markers under a small budget.
4. A path outside the assigned worktree and a fabricated MCP tool name: both are rejected before action.
5. A claimed "done" with a missing required check and a retry after lost launch response: receipt remains incomplete and no duplicate handoff blocks appear.

Measure accepted completion after human review, missing artifact rate, false ready_for_review rate, cross-repo writes, handoff reconstruction time, tokens in transfer packet, wall time, and operator correction time. Record task IDs and harness version with every observation. Zero cross-repo writes and zero false ready_for_review in the fixture set are release gates; an observed escape or false approval blocks rollout. Keep model/provider and budget fixed for paired comparisons; report sample size and uncertainty. Do not turn an algorithmic coding benchmark into a claim about business-workflow automation.

## Delivery sequence

P0 — Freeze the current interface and add failing contract tests for identity, task type, revision conflict, and atomic artifact writes. Implement manifest migration and doctor checks without changing the user workflow.

P1 — Build versioned transfer packets with budget policy and provider-agnostic evidence references. Wire them through current handoff/launchers; retain human initiation and atem:// compatibility.

P2 — Add the receipt generator and CLI/MCP read view. Validate against observed commands and Git state, including honest unknown outcomes and failure recovery.

P3 — Evaluate on the fixture set, then pilot with one Ops Central documentation task and one bounded implementation task in isolated worktrees. Review results before enabling any stricter default gate. Roll back by disabling new receipt/packet gating while preserving readable legacy Markdown; never discard artifacts.

Assign each phase a maintainer and PR before coding. P0 and P1 are the initial implementation handoff; P2 and P3 are conditional on P0/P1 evidence. Any proposal for autonomous orchestration, generic model benchmarking, hosted telemetry, or Ops Central business-action authorization requires a separate decision and does not expand this spec.

## Open decisions for the implementation PR

- Choose manifest placement and atomic write semantics across macOS, Linux, and Windows; prove concurrent writer behavior.
- Define which validations are required per task versus chosen by the operator. The receipt may not invent requirements.
- Confirm how a provider launch acknowledgement is obtained on each supported launcher; report unknown when it cannot be observed.
- Decide the packet size policy with measured provider limits. Begin with a conservative configurable budget, not a claimed universal optimum.

## Handoff to maintainer

Begin with P0 against src/cli.js, src/handles.js, src/url.js, src/materialize.js, and the current test suite; inspect actual helpers before choosing module ownership. Keep README claims tied to shipped behavior. Submit each phase as a separate reviewable PR with fixture output, migration notes, and a sample receipt. The present PR changes documentation only and is ready for maintainer review, not feature release.
