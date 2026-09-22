// Score Jev's tier predictions against the observed-effort labels.
//
// Plain accuracy is the wrong headline. The two error directions cost very
// different amounts:
//
//   UNDER-ROUTE  Jev said cheap, the task needed expensive.
//                You pay for a failed cheap run AND the expensive rerun,
//                plus your own time noticing. This is the number that
//                decides whether to ship.
//
//   OVER-ROUTE   Jev said expensive, the task was cheap.
//                You overpay, but the answer is right. This is the status quo
//                today, so it is not a regression, only a missed saving.

import { TIERS, TIER_ORDER } from "./label.mjs";

// Rough blended per-task cost by tier, in USD. These are assumptions for
// ranking options, not billing figures. Override with --costs.
export const DEFAULT_TIER_COST = {
  trivial: 0.0,
  mechanical: 0.0,
  implement: 0.35,
  reason: 1.20,
};

const JEV_INPUT_USD_PER_TOKEN = 0.042 / 1_000_000;

// A digest of an opening request plus the two questions lands near 300 tokens
// in practice. Raise this if your digests grow; `predict` prints the real mean
// once you have sent anything.
export function score(records, { tierCost = DEFAULT_TIER_COST, jevTokensPerCall = 300 } = {}) {
  const scored = records.filter((r) => r.jev?.tier && r.truth?.tier);
  const matrix = {};
  for (const a of TIERS) matrix[a] = Object.fromEntries(TIERS.map((b) => [b, 0]));

  let under = 0;
  let over = 0;
  let exact = 0;
  let baselineCost = 0; // everything on the expensive tier, i.e. today
  let routedCost = 0;   // Jev's routing, including the cost of being wrong

  for (const r of scored) {
    const truth = r.truth.tier;
    const pred = r.jev.tier;
    matrix[truth][pred] += 1;

    if (pred === truth) exact += 1;
    else if (TIER_ORDER[pred] < TIER_ORDER[truth]) under += 1;
    else over += 1;

    baselineCost += tierCost.reason;

    // An under-route is charged twice: the wasted cheap attempt, then the
    // tier the task actually needed.
    routedCost +=
      TIER_ORDER[pred] < TIER_ORDER[truth]
        ? tierCost[pred] + tierCost[truth]
        : tierCost[pred];
  }

  const n = scored.length || 1;
  const jevCost = scored.length * jevTokensPerCall * JEV_INPUT_USD_PER_TOKEN;
  const lat = records.map((r) => r.jev?.ms).filter((x) => typeof x === "number").sort((a, b) => a - b);

  return {
    n: scored.length,
    skipped: records.length - scored.length,
    accuracy: exact / n,
    underRouteRate: under / n,
    overRouteRate: over / n,
    matrix,
    truthDistribution: countBy(scored, (r) => r.truth.tier),
    predDistribution: countBy(scored, (r) => r.jev.tier),
    lowConfidenceShare: scored.filter((r) => r.truth.confidence === "low").length / n,
    cost: {
      baselineUsd: round(baselineCost),
      routedUsd: round(routedCost),
      jevUsd: round(jevCost, 4),
      netSavingUsd: round(baselineCost - routedCost - jevCost),
    },
    latencyMs: lat.length
      ? { p50: lat[Math.floor(lat.length * 0.5)], p95: lat[Math.floor(lat.length * 0.95)], max: lat.at(-1) }
      : null,
  };
}

function countBy(arr, fn) {
  const o = {};
  for (const x of arr) o[fn(x)] = (o[fn(x)] || 0) + 1;
  return o;
}

function round(n, dp = 2) {
  return Math.round(n * 10 ** dp) / 10 ** dp;
}

export function formatReport(s, { thresholdUnder = 0.1 } = {}) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const L = [];
  L.push(`scored: ${s.n} tasks (${s.skipped} without a prediction)`);
  L.push("");
  L.push(`accuracy        ${pct(s.accuracy)}`);
  L.push(`under-route     ${pct(s.underRouteRate)}   <- the expensive error`);
  L.push(`over-route      ${pct(s.overRouteRate)}`);
  L.push("");
  L.push("confusion matrix (rows = observed effort, cols = Jev)");
  const w = 12;
  L.push("".padEnd(w) + TIERS.map((t) => t.padEnd(w)).join(""));
  for (const t of TIERS) {
    L.push(t.padEnd(w) + TIERS.map((p) => String(s.matrix[t][p]).padEnd(w)).join(""));
  }
  L.push("");
  L.push(`baseline (all on reason tier)  $${s.cost.baselineUsd}`);
  L.push(`with Jev routing               $${s.cost.routedUsd}`);
  L.push(`Jev api cost                   $${s.cost.jevUsd}`);
  L.push(`net saving                     $${s.cost.netSavingUsd}`);
  if (s.latencyMs) {
    L.push("");
    L.push(`latency  p50 ${s.latencyMs.p50}ms  p95 ${s.latencyMs.p95}ms  max ${s.latencyMs.max}ms`);
  }
  L.push("");
  L.push(
    s.underRouteRate <= thresholdUnder
      ? `VERDICT: under-route rate is within ${pct(thresholdUnder)}. Worth a shadow run.`
      : `VERDICT: under-route rate exceeds ${pct(thresholdUnder)}. Do not ship this as an automatic router.`,
  );
  L.push(
    `CAVEAT: ground truth is the observed-effort heuristic, and ${pct(s.lowConfidenceShare)} of labels sit near a threshold. Hand-review before trusting the accuracy figure.`,
  );
  return L.join("\n");
}
