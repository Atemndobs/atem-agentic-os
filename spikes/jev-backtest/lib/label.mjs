// Ground-truth tier from observed effort.
//
// THIS IS A PROXY, NOT TRUTH. It infers "what tier did this task need?" from
// what the session actually did. That is a defensible signal (a task that
// touched 9 files over 40 turns was not trivial) but it is not the same as a
// human judging the task. Two known ways it lies:
//
//   1. A task Opus handled in 3 turns looks "mechanical" here, even though a
//      small model might have flailed for 30. Effort reflects the model that
//      ran, not the task's intrinsic difficulty.
//   2. An abandoned session looks cheap because you gave up, not because it
//      was easy.
//
// Treat the output as a screening signal. Before trusting any accuracy number,
// hand-label a sample with `backtest label --review` and compare.

export const TIERS = ["trivial", "mechanical", "implement", "reason"];

export const DEFAULT_THRESHOLDS = {
  trivialMaxTurns: 3,
  mechanicalMaxTurns: 10,
  mechanicalMaxEdits: 2,
  implementMinEdits: 3,
  reasonMinTurns: 30,
  reasonMinFiles: 5,
  reasonMinContext: 150_000,
};

export function labelTier(outcome, t = DEFAULT_THRESHOLDS) {
  const { assistantTurns: turns, edits, distinctFiles, maxContextTokens } = outcome;

  // Sustained, wide, or context-heavy work is the expensive tier.
  if (
    turns >= t.reasonMinTurns ||
    distinctFiles >= t.reasonMinFiles ||
    maxContextTokens >= t.reasonMinContext
  ) {
    return "reason";
  }

  if (edits >= t.implementMinEdits) return "implement";

  if (turns <= t.trivialMaxTurns && edits === 0) return "trivial";

  if (turns <= t.mechanicalMaxTurns && edits <= t.mechanicalMaxEdits) {
    return "mechanical";
  }

  return "implement";
}

/** Tiers a given provider tier can safely absorb, cheapest first. */
export const TIER_ORDER = Object.fromEntries(TIERS.map((t, i) => [t, i]));

/**
 * Confidence that the heuristic label is meaningful. Sessions sitting right on
 * a threshold are the ones worth hand-reviewing first.
 */
export function labelConfidence(outcome, t = DEFAULT_THRESHOLDS) {
  const { assistantTurns: turns, edits } = outcome;
  const near = [
    Math.abs(turns - t.trivialMaxTurns),
    Math.abs(turns - t.mechanicalMaxTurns),
    Math.abs(turns - t.reasonMinTurns),
    Math.abs(edits - t.implementMinEdits) * 3,
  ];
  const d = Math.min(...near);
  if (d <= 1) return "low";
  if (d <= 4) return "medium";
  return "high";
}

export function labelAll(records, thresholds = DEFAULT_THRESHOLDS) {
  return records.map((r) => ({
    ...r,
    truth: {
      tier: labelTier(r.outcome, thresholds),
      confidence: labelConfidence(r.outcome, thresholds),
      source: "heuristic",
    },
  }));
}
