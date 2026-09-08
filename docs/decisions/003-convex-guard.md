# ADR-003: Convex Guard is a Harness capability, distributed by vendoring

> Date: 2026-09-08
> Status: Proposed
> Relates to: [ADR-001](001-atem-naming.md), Ops Central's
> [coverage matrix](https://github.com/Atemndobs/ops-central/blob/main/Docs/2026-09-08-convex-rule-coverage-matrix.md)

## Context

Ops Central spent 2026 paying for Convex reads it did not need. A 10.66 GB
incident in July produced a written standard (twelve rules) and a static checker
that enforces four of them. A coverage matrix taken today found the rest are
documentation, that the checker's baseline counts findings rather than
identifying them, and that ESLint runs in no CI job at all.

The knowledge is not the gap. The gate is. And the gap is not Ops Central's
alone: every Convex repository on this machine has the same exposure and none of
them has any check.

**Measured fleet, 2026-09-08.** Distinct repositories, worktrees collapsed:

| Repository | Convex files | Pinned |
| --- | --- | --- |
| opscentral-admin | 361 | ^1.45.0 |
| jna-cleaners-app | 147 | ^1.31.6 |
| curator-app | 93 | ^1.16.0 |
| curator-claude | 36 | ^1.16.0 |
| nweh-lingo | 26 | ^1.40.0 |
| photo-menu | 16 | ^1.31.5 |
| family-fund-thermometer | 11 | ^1.45.0 |
| job4me | 8 | ^1.31.5 |
| fireside-finance | 5 | ^1.31.4 |
| pidgin-lingo-app | 4 | ^1.16.0 |
| family-fund-fire | 3 | ^1.32.0 |

Eleven repositories, roughly 710 Convex files, and versions spanning 1.16 to
1.45. Three repositories are twenty-nine minor versions behind. That spread is
itself an argument for a control plane: nobody is going to walk eleven repos by
hand, and the walk would be stale the week after.

## Decision

Convex Guard is an ATEM Harness capability. Not a separate repository, and not a
Claude Code plugin that only works when Claude is the one typing.

| Layer | Owns |
| --- | --- |
| **ATEM Harness** | The standard, repository detection, installation, upgrade, fleet audit, drift reporting |
| **Claude Code** | Design guidance, hooks, review commands, repair instructions, received from the Harness |
| **Each repository** | A config file, a pinned guardrail version, a fingerprinted baseline, and a required CI check |
| **Codex** | Independent review of changes and of exceptions |
| **Convex telemetry** | Production cost feeding new rules and thresholds |

Names, fixed here so they stop drifting:

- Process: **Convex Cost-Safe Delivery Standard**
- Harness capability: **ATEM Convex Guard**
- Claude component: **Convex Guard plugin**
- Repository check: **Convex Read-Cost Ratchet**

## The constraint that shapes distribution

`atem-agentic-os` is **not published to npm** and its GitHub repository is
**private**. A required CI check in eleven other repositories therefore cannot
`npm install` or `npx` the Harness. Any design where the repository's gate needs
to reach the Harness at CI time needs a token in every repository, which is a
secret to rotate, a way to be locked out, and a check that fails for reasons
unrelated to the code.

Four options were considered.

| Option | Verdict |
| --- | --- |
| Repo CI installs the Harness from the private repo | Rejected. A PAT in eleven repositories, failing closed on token expiry |
| Publish a public `@atem/convex-guard` npm package | Viable, deferred. Publishing is a release process we do not have yet, and it puts the standard in public |
| A published GitHub Action | Same publishing problem, plus the action repository must be reachable |
| **Vendor a self-contained scanner into each repository** | **Chosen** |

**The scanner is vendored.** One dependency-free file, checked into each
repository, run by `node` in CI with nothing to install. The Harness owns the
source, stamps a version into the file and into `.convex-cost.json`, and
`atem guardrails convex upgrade --all` re-vendors it and opens a PR per
repository. `audit --all` compares each vendored copy's version and hash against
the Harness and reports drift.

This is deliberately the same shape as the existing checker, which is one file
with no dependencies and is the reason it survived being copied around at all.

Vendoring also answers the bypass question directly. The check is a file in the
repository, wired to a required status check. Editing through the GitHub web UI,
another agent, an IDE or a local script still faces it, because the gate is not
in the tool that happens to be writing the code.

## Repository footprint

```text
.convex-guard/scanner.mjs        vendored, versioned, dependency-free
.convex-cost.json                config: rules on/off, thresholds, guard version
.convex-cost-baseline.json       fingerprinted findings, not counts
.github/workflows/convex-cost.yml
```

`.convex-cost.json` carries the pinned guard version, so a repository states
which standard it is holding itself to and the fleet audit can see when that is
behind.

## Harness structure

```text
atem-harness/
└── guardrails/
    └── convex/
        ├── policy/        the standard, rules, thresholds, exception schema
        ├── scanner/       the AST scanner, source of the vendored artifact
        ├── claude-plugin/ skills, hooks, review commands
        ├── repo-template/ the four files above
        ├── migrations/    baseline format upgrades, count to fingerprint
        └── fleet-audit/   inventory, drift, expired exceptions
```

```bash
atem guardrails convex inventory          # find Convex repositories, classify them
atem guardrails convex adopt <repo>       # install the footprint, generate a baseline
atem guardrails convex audit --all        # drift, expired exceptions, stale versions
atem guardrails convex upgrade --all      # re-vendor, open PRs
atem guardrails convex status             # one repository's posture
```

## Fingerprints, not counts

Today's baseline records a number:

```json
"convex/admin/mutations.ts": { "bare-scan": 12 }
```

The check fails only when a count exceeds its baseline, so removing one violation
and adding another passes. Green means the count did not rise.

A finding is identified by `file + exported function + rule + query fingerprint`,
where the fingerprint is a hash of the normalised query chain from the AST. A new
violation then fails even when an old one disappears in the same file, and an
approved exception stays identifiable when the lines around it move.

`migrations/` exists because eleven repositories will adopt at different times
and the count-shaped baseline has to convert without a flag day.

## AST, not more regexes

The existing scanner missed 72% of query calls until multi-line shapes were
handled, and the newly installed Convex ESLint plugin finds 22 filter violations
where the regex finds 11. Both are measurements, not opinions.

Rules use the TypeScript AST, parse `schema.ts` so a rule knows the tables and
their indexes, and trace helpers far enough to see a query hidden behind a
per-row call. Every rule ships with three tests: a true violation, a correct
implementation, and a false-positive guard.

Where Convex publishes a rule, we use theirs. `no-top-of-hour-crons` was on our
list to write and already exists upstream.

## What this cannot do

Cost is documents read, times write frequency over that range, times active
subscribers. A scanner sees the first term. Both of this year's incidents were
invisible to one: the July amplification was subscribers, the `users.avatarUrl`
bloat was bytes per document.

So the standard has a runtime half from the start. `convex-advisor`,
`convex-cost` and `convex-insights` read a deployment's insights, and the fleet
audit is where those become scheduled rather than occasional. **Static green with
runtime red is a failure**, and today nothing reports it.

## Rollout

1. Build Ratchet v2 as a Harness capability.
2. Pilot on Ops Central, which has the baseline, the incidents and the tests.
3. Inventory and classify every Convex repository.
4. Install in **audit mode** everywhere: reports, gates nothing.
5. Review and approve the fingerprinted legacy baselines.
6. Turn the CI check required, repository by repository.
7. Add Convex Guard to the Harness's new-project bootstrap.
8. Schedule the fleet audit for stale rules, expired exceptions, config drift.

Audit mode before enforcement is the part that matters. Eleven repositories
adopting a gate on the same day, with roughly 710 files of unreviewed history,
would produce a wall of red that gets bypassed rather than read.

## Consequences

- The Harness gains a capability that is not session handoff, which is a widening
  of its scope. That is the point: it is the control plane.
- A vendored artifact drifts by nature. `audit --all` exists precisely because
  the choice creates that problem, and reports it rather than pretending.
- Publishing to npm stays open. If a release process appears, the vendored file
  becomes a thin shim and nothing else changes.
