# jev-backtest

A spike that answers one question before you wire anything up:

> Would routing tasks to cheaper providers with a fast typed classifier
> (Jev / TypeSafe System One) actually save enough to be worth it?

It replays your own Claude Code session history, asks the classifier which
provider tier each task should have gone to, and scores that against what the
session actually turned out to cost. Run it before building a router, not after.

## Usage

```bash
node backtest.mjs extract          # read ~/.claude/projects, build digests locally
node backtest.mjs label            # assign observed-effort ground truth
node backtest.mjs predict          # DRY RUN: writes payloads, sends nothing
node backtest.mjs predict --send   # actually calls Jev (needs TYPESAFE_API_KEY)
node backtest.mjs score            # confusion matrix + cost model
```

Flags: `--days 30`, `--min-turns 2`, `--sample 100`, `--concurrency 4`,
`--include-synthetic`, `--review 20`, `--threshold-under 0.1`.

Everything lands in `out/`, which is gitignored. Responses are cached by payload
hash, so a rerun costs nothing and an interrupted run resumes instead of
re-billing.

## Safety

- **Nothing leaves the machine without `--send`.** The dry run writes the exact
  bytes that would be sent to `out/cache/*.payload.json` so you can read them
  first.
- Every digest passes through `lib/redact.mjs` at build time, so the on-disk
  dataset is already scrubbed of keys, tokens, emails, IPs and home paths. It is
  a coarse net, not a guarantee. Read a sample before enabling `--send`.
- `out/` is gitignored on purpose: it holds the opening prompt of every session
  it read.

## The rule that makes this a real backtest

`record.digest` holds only what exists **at routing time**: the project, the
branch, and the opening request. `record.outcome` holds what the session
actually cost, which is knowable only afterwards.

Ground truth is derived from `outcome`. The classifier only ever sees `digest`.
Leak anything from `outcome` into `digest` and the result is meaningless,
because the classifier would be judging a task whose answer it can already see.

## How it decides

`lib/score.mjs` does not lead with accuracy, because the two error directions
cost very different amounts:

- **Under-route** means a hard task went to a cheap tier. You pay for the failed
  cheap run, the expensive rerun, and your own time noticing. This is the number
  that decides whether to ship.
- **Over-route** means an easy task went to an expensive tier. You overpay but
  the answer is right, so it is a missed saving rather than a regression.

It also reports what the routed run would have cost against a baseline of
sending everything to the expensive tier, so you can see whether a *perfect*
classifier would even save enough to bother. Often that ceiling is the real
answer and the accuracy question never needs asking.

## Reading the results honestly

- **Ground truth is a proxy.** `lib/label.mjs` infers the tier a task needed from
  the effort the session actually spent. That is a defensible signal, not a human
  judgement, and it has two known failure modes documented in that file. Use
  `label --review` to hand-check the labels sitting near a threshold before
  trusting any accuracy figure.
- **Dollar figures are API-equivalent list prices, not a bill.** Cache reads are
  assumed at the standard multiplier, which is an assumption. On a subscription
  the real constraint is rate limits, not dollars. Use the numbers to rank where
  load sits, not as money owed.
- **Two counting traps are handled, and both inflate spend if you miss them.**
  Claude Code writes one record per content block and each repeats the same
  usage, so `extract.mjs` counts usage once per message id. Forked sessions copy
  their parent's history into the new file, so a naive per-file sum double counts
  a prefix that was billed once.
- **Most sessions may not be yours.** Observer and automation plugins can open
  far more sessions than a person does. They are filtered by default; pass
  `--include-synthetic` to keep them.

## Layout

| File | Does |
|---|---|
| `backtest.mjs` | CLI |
| `lib/extract.mjs` | transcripts to records, digest/outcome split, dedupe |
| `lib/label.mjs` | observed-effort tier, with confidence |
| `lib/redact.mjs` | secret and identifier scrubbing |
| `lib/jev.mjs` | client, dry run, on-disk cache |
| `lib/score.mjs` | confusion matrix, under/over-route, cost model |
