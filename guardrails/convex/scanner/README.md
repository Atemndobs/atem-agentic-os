# Convex Read-Cost Ratchet, v2 scanner

The scanning half of [ATEM Convex Guard](../../../docs/decisions/003-convex-guard.md).
Findings are identified, not counted. Rules read a TypeScript AST, not text.

```bash
node scan-repo.mjs /path/to/repo          # summary
node scan-repo.mjs /path/to/repo --json   # findings with fingerprints
```

`typescript` is resolved from the repository being scanned. Nothing is installed.

## Pilot: Ops Central, 2026-09-08

361 Convex files. The v1 checker reports 225 findings across its four rules and
calls everything below **safe**.

| Rule | Findings |
| --- | --- |
| `unbounded-index-collect` | 298 |
| `index-without-range` | 52 |
| `dynamic-large-take` | 37 |
| `scan-to-count` | 0 |
| `post-collect-cap` | 0 |
| **total** | **387** in 343 distinct fingerprints |

**387 findings the current gate considers safe**, because it stops at "does this
chain have a `.withIndex`".

Read that number carefully. 298 unbounded index collects are 298 reads whose size
is decided by the data rather than by the code. Many will be fine in practice: a
user's capability rows are a handful, and `.collect()` on them is not a problem
worth a PR. The rule cannot tell those apart, which is the argument for audit
mode and a ranked review rather than switching a gate on and watching people
route around it.

## Known limits, today

- **`scan-to-count` catches the direct form only.** It sees
  `(await ...collect()).length` and misses the two-step version:

  ```ts
  const rows = await ctx.db.query("jobs").withIndex(...).collect();
  return rows.length;
  ```

  which is the more common way to write it. Zero findings here means the direct
  form is absent, not that R8 is respected. Local dataflow is the fix.
- **`post-collect-cap` likewise**, for the same reason.
- **No schema awareness yet.** Rules do not read `schema.ts`, so nothing knows
  which table a query hits, how many indexes it has, or whether an index exists
  for the predicate. `redundant-index` and a smarter `index-without-range` need it.
- **No helper tracing.** A query inside a helper called per row is invisible,
  which is half of R3.

## Adding a rule

A rule is `{ id, check(chain, { ts, sourceFile, schema }) }` returning zero or
more `{ message, line? }`. The chain is flattened, so `chain.has("withIndex")`
and `chain.find("take")` work regardless of how the source was wrapped or
formatted.

Three tests per rule, no exceptions: a true violation, a correct implementation,
and a false-positive guard. The guard is the one that matters. A rule that fires
on correct code gets switched off, and a rule that is off enforces nothing.

Two of the five rules failed their first run against real code, both because
they read `chain.node.parent` and every real chain is wrapped in `await (...)`.
Tests written against realistic source caught it; tests written against the
shape I had in mind would not have.
