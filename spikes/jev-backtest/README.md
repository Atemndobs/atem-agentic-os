# jev-backtest

Does routing ATEM tasks with a cheap typed classifier (Jev / TypeSafe System One)
actually save model spend?

Run it before wiring any router. On this machine, the answer came out **no**, and
it came out before a single Jev call was made.

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

Everything lands in `out/`. Responses are cached by payload hash, so a rerun
costs nothing and an interrupted run resumes instead of re-billing.

## Safety

- Nothing leaves the machine without `--send`. The dry run writes the exact
  bytes that would be sent to `out/cache/*.payload.json` so you can read them.
- Every digest passes through `lib/redact.mjs` at build time, so the on-disk
  dataset is already scrubbed of keys, tokens, emails, IPs and home paths.
  It is a coarse net, not a guarantee. Read a sample before enabling `--send`.

## The one rule that makes this a real backtest

`record.digest` holds only what exists **at routing time**: the project, the
branch, and the opening request. `record.outcome` holds what the session
actually cost, which is knowable only afterwards. Ground truth is derived from
`outcome`; Jev only ever sees `digest`. Leak anything from `outcome` into
`digest` and the result is meaningless.

## Findings, 2026-09-21 (corrected)

Measured over 30 days of `~/.claude/projects`.

> An earlier version of this file overstated spend about 2.7x. Claude Code writes
> one record per content block, each repeating the same usage, and forked
> sessions copy their parent's history into the new file. Both are now handled:
> `extract.mjs` counts usage once per message id, and the global figure below is
> deduped across files. 109,286 records were 42,965 real API calls.

**1. Most sessions are not yours.** About 2,100 of ~2,400 sessions were started
by the `claude-mem` observer plugin (Haiku 4.5). They are filtered by default.
Real routable tasks: ~265.

**2. Spend sits almost entirely in one tier**, so routing cannot help:

| tier | tasks | share of spend |
|---|---|---|
| trivial | 25 | 0.1% |
| mechanical | 71 | 0.3% |
| implement | 40 | 0.4% |
| reason | 128 | **99.2%** |

Deduped 30-day equivalent at Opus 5 list rates: **~$11,500**. A perfect router
reaches under 1% of it.

## Why the expensive sessions are expensive

Swept the 50 costliest sessions (92% of deduped spend).

**Screenshots, in long sessions.** This is the pattern.

| pattern | sessions | share of all spend |
|---|---|---|
| mean context > 300K | 36 | 85.0% |
| screenshots >= 30% of tool-result content | 33 | 73.7% |
| both | 24 | **68.8%** |
| no screenshots at all | 15 | 15.9% |

Screenshot share is measured by tool results containing an `image` block.
Offenders: Claude Browser `computer` / `browser_batch`, the iOS Simulator
`control` screenshot, claude-in-chrome `computer`. A single result reaches
240K characters. In the top session, 196 image results were 70% of all
tool-result content while 7,500 Bash calls were a small fraction.

**Compaction runs, but late.** The top session compacted 28 times. The 1M
window means each compaction fires near the ceiling, so mean context still sat
at ~530K and each token was re-sent hundreds of times. Capping at 150K would
cost roughly 17% of actual, at 300K roughly 31% (sawtooth estimate, a floor).

**Forks were not re-billed.** The three dashboard files share their first ~255
prompts, but the shared prefix was billed once. Deduped, the cluster is $3,240,
not $11,919. Forking is a context-hygiene smell, not a triple charge.

**15 expensive sessions have no screenshots** (16% of spend): backend import
pipelines, curator, admin deploys. Their cost is length alone: mean context
~490K with minimal compaction.

### What to change, in order of reach

1. **Stop screenshotting to read** (~70% of spend is in sessions dominated by
   it). CLAUDE.md already says prefer text reads over screenshots. Use
   `read_page` / `get_page_text` and the simulator's `inspect`; pass `scale`
   when an image is genuinely needed.
2. **Hand off on context growth at ~150K** rather than letting a 1M window run
   to the ceiling. This covers the no-screenshot sessions too. ATEM's handoff
   layer is the natural place for the trigger.

## Caveats

- **Ground truth is a proxy.** `lib/label.mjs` infers the tier a task needed
  from the effort the session actually spent. That is a defensible signal, not a
  human judgement, and it has two known failure modes documented in that file.
  85 of 264 labels sit near a threshold. Hand-check with `label --review` before
  trusting any accuracy figure.
- **The dollar figures are API-equivalent list prices, not a bill.** Opus 5 at
  $5/M input and $25/M output, with cache reads assumed at the standard 0.1x
  multiplier, which is an assumption and not a verified rate. On a subscription
  the real constraint is rate limits, not dollars; treat these numbers as a way
  to rank where the load is, not as money owed.
- **Screenshot share is by characters of serialized results**, a proxy for
  tokens. Image tokenization differs from text, so the dollar share of
  screenshots is correlated with, not equal to, their character share.
- **No Jev call has ever been made.** Latency, calibration and accuracy are all
  still unmeasured. The conclusion above does not depend on them: even a perfect
  classifier reaches under 1% of spend.
