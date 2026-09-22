# ATEM Convex Guard: latest Git review packet

> Prepared: 2026-09-08  
> Remote: `Atemndobs/atem-agentic-os` / `origin/main`  
> Revision: `4775791eba9e4cdd0ffd2f12f8052f6e542c05ea`  
> Source: merged PR #2, “ATEM Convex Guard: Ratchet v2 scanner, fingerprinted baseline, repo footprint”

## Executive assessment

PR #2 is merged. It adds a TypeScript-AST Convex query scanner, five read-cost rules, fingerprinted baselines, expiring exceptions, audit/enforce modes, ADR-003, a repository template, fixture tests, and the repository's first GitHub Actions test workflow.

The architecture is promising: fingerprints close the old count-swap loophole, AST traversal is more credible than regex matching, and audit-first adoption is appropriate for hundreds of existing findings. Treat this as a pilot, not a fleet-wide enforcing release, until the high-severity issues below are fixed.

## Git state and scope

- Latest `origin/main`: `4775791`; local `main` is still `85d39bc`.
- Current local branch: `docs/dsh-assessment-event-log-sketch`.
- PR #2 is closed/merged and its head ref was deleted.
- Merge footprint: 19 files, about 1,757 insertions and 1 deletion.
- `git diff --check` passes.
- Main additions: `.github/workflows/tests.yml`, ADR-003, `guardrails/convex/{scanner,repo-template}`, `scripts/test-partition.mjs`, `test/QUARANTINE.md`, three guard tests, and TypeScript as a dev dependency.

## Behavior introduced

`scan-repo.mjs` finds Convex TypeScript files. `engine.mjs` parses them with the target repository's TypeScript installation, flattens database query chains, and applies:

| Rule | Detection intent |
| --- | --- |
| `unbounded-index-collect` | Indexed collect without a read-side cap |
| `index-without-range` | `.withIndex()` without a range restriction |
| `scan-to-count` | Full collect used only for `.length` |
| `post-collect-cap` | `.slice()` applied after `.collect()` |
| `dynamic-large-take` | Non-static/caller-controlled `.take()` |

Finding IDs combine file, scope, rule, and normalized chain. Baselines distinguish new, fixed, excepted, and expired findings. ADR-003 chooses vendoring because the Harness is private and unpublished.

## Validation evidence

An isolated checkout of the final merged `origin/main` revision was validated:

- `npm ci` succeeded;
- 262/262 tests passed;
- `npm audit` found 0 vulnerabilities;
- patch whitespace checks passed.

The final commits added CI, a real fixture, determinism checks, and quarantine for machine-dependent tests. The complete local suite passed; ChatGPT should independently verify the final Actions jobs and exact portable/quarantined test counts.

## Findings

### F1 — High: malformed config fails open

`guardrails/convex/scanner/cli.mjs` catches every config read/parse error and returns defaults, whose mode is `audit`. A typo, truncated file, or permission failure in an enforcing config can silently become a passing audit.

Fix: treat only `ENOENT` as absence; fail with code 2 for parse/read/schema errors; validate `mode` as `audit | enforce`; test that malformed enforce config cannot pass.

### F2 — High: baseline updates delete exceptions

`baseline.mjs::saveBaseline()` writes version, guard, and findings, but not exceptions. The `--update-baseline` path therefore discards existing time-bounded exceptions.

Fix: preserve exceptions by default; remove them only explicitly; add an exception round-trip test.

### F3 — Medium: JSON changes audit exit semantics

The `--json` branch returns `result.ok ? 0 : 1` before audit-mode handling. Text audit runs exit 0, while JSON audit runs can exit 1 for identical findings.

Fix: calculate exit status independently of formatting; test audit/enforce × text/JSON.

### F4 — High design gap: the promised vendored artifact is not deliverable

ADR-003 describes one dependency-free vendored file. The implementation has multiple runtime modules, while the repository template does not contain the `.convex-guard/cli.mjs` artifact its workflow invokes. This change also does not implement the documented install/upgrade/audit commands or a deterministic bundling step.

Fix: either emit and hash one deterministic `.mjs` artifact with installer/upgrade commands, or amend the ADR to define a vendored directory/module set. Do not roll out to eleven repositories until this is reproducible end to end.

### F5 — Medium: fingerprint scope may be a local variable

`engine.mjs::enclosingScope()` keeps the first variable/function name found while walking upward. For an exported query containing `const rows = await ctx.db.query(...).collect()`, the scope can become `rows`, not the exported query name.

Impact: harmless local renames churn baselines and distinct exports have weaker identity separation. Fix by resolving the containing Convex export and testing named intermediates in multiple exports.

### F6 — Medium: fingerprint source is binary to Git

Git reports `fingerprint.mjs` as `Bin 0 -> 3291 bytes`; byte diagnostics identify a raw NUL. The likely intent is a hash-field separator, but this blocks normal line review and can disrupt text-oriented vendoring, patching, and integrity tooling.

Fix: express the delimiter textually (`"\\0"`/`"\\u0000"`) or construct it at runtime. Preserve existing hashes or version and migrate the fingerprint schema. Add a no-NUL source check.

### F7 — Medium: use tracking compares names, not bindings

`engine.mjs::resultUses()` searches by identifier text and does not exclude nested scopes or shadowed declarations. A shadowed `rows.length` can make a different collected `rows` appear to be `scan-to-count`.

Fix: use declaration-aware binding resolution, or at least skip nested functions and stop at shadowing declarations. Add nested-scope false-positive tests.

### F8 — Low: expired findings can appear twice

Expired exceptions are added to `expired` but remain unexcused in `added`/blocking. The same finding can be reported as both new and expired.

Fix: partition findings into disjoint unexcepted, live-exception, and expired-exception sets and assert disjointness.

### F9 — Operational: CI quarantines machine-dependent behavior

Quarantine is documented, which is good, but environment-sensitive adapter/launcher behavior is outside GitHub-hosted coverage.

Fix: make quarantine exact and non-growing without explicit review; report both counts; run quarantined tests on a scheduled/self-hosted runner.

## Strengths to preserve

- Fingerprints close the count-only ratchet loophole.
- AST parsing handles realistic multiline shapes.
- Traversal and policy rules are cleanly separated.
- Fixed findings remain visible for deliberate ratcheting.
- Exceptions require expiry metadata.
- Audit-first rollout acknowledges the 451 pilot findings.
- Known limitations are documented.
- CI and real fixture/determinism tests were added.

## Documented limitations

The implementation acknowledges no schema awareness, no proof that predicates match indexes, no helper tracing for per-row queries, limited local assignment tracking, no cross-function data flow, and heuristic findings requiring human review. These are acceptable pilot constraints if the guard is not represented as comprehensive cost safety.

## Recommendation

Keep the merge, but do not deploy it as an enforcing fleet-wide gate yet:

1. Fix F1/F2 before relying on enforcement or exceptions.
2. Fix F3 for machine-readable audit use.
3. Resolve F4 end to end.
4. Fix or version F5/F6 before baselines spread.
5. Add F7/F8 regression tests.
6. Pilot one repository in audit mode, review findings, then promote rules individually.

## Copy/paste prompt for ChatGPT

```text
Review this ATEM Convex Guard report as a skeptical senior engineer. Focus on correctness and bypass resistance, not style. For every finding, state agree/partially agree/disagree, explain the exact execution path, assign severity, and propose the smallest robust fix plus a regression test. Then identify additional issues the report missed.

Pay special attention to fail-open config parsing, baseline/exception lifecycle, audit versus enforce exit codes, fingerprint stability and collisions, lexical bindings in AST analysis, the one-file-vendoring versus multi-module gap, and CI quarantine.

Reviewed revision: 4775791eba9e4cdd0ffd2f12f8052f6e542c05ea

Require code-path evidence. Do not assume a passing suite proves the absence of untested fail-open paths.
```

## Boundary

This reviews the latest merged Git state. It does not modify `main`, deploy downstream, or approve ADR-003, which remains `Proposed`.
