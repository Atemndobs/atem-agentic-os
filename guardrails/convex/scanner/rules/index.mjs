/**
 * The five rules Ratchet v2 starts with.
 *
 * Chosen because each one is a shape the existing checker calls SAFE. It looks
 * for a missing `.withIndex` and stops there, so a query that reads an entire
 * indexed range, counts by collecting, caps after reading, or takes a
 * caller-supplied limit all pass it today.
 *
 * Rules do not parse. They read the flattened chain the engine hands them.
 */

/** Terminators that materialise rows. `.paginate` is bounded by construction. */
const MATERIALISERS = new Set(["collect", "take", "first", "unique"]);

/** A `.take(n)` or `.paginate()` anywhere in the chain bounds it. */
function isBounded(chain) {
  return chain.has("take") || chain.has("paginate") || chain.has("first") || chain.has("unique");
}

/**
 * An index range call with no bound reads the whole index.
 *
 * `.withIndex("by_property")` with no callback narrows nothing: it walks every
 * row in index order. The bound has to be `q.eq`, `q.gte`, `q.lt` or a
 * neighbour of those.
 */
export const indexWithoutRange = {
  id: "index-without-range",
  check(chain, { ts }) {
    const call = chain.find("withIndex");
    if (!call) return [];
    // One argument is the index name alone.
    if (call.args.length < 2) {
      return [
        {
          message:
            `.withIndex("${literal(ts, call.args[0]) ?? "?"}") has no range. ` +
            `An index with no bound is read in full, in index order.`,
        },
      ];
    }
    const range = call.args[1];
    const text = range.getText();
    if (!/\bq\s*\.\s*(eq|gt|gte|lt|lte)\s*\(/.test(text)) {
      return [
        {
          message:
            `.withIndex(...) has a callback that never bounds the range ` +
            `(no q.eq/gt/gte/lt/lte), so it still walks the whole index.`,
        },
      ];
    }
    return [];
  },
};

/**
 * `.withIndex(...).collect()` is not automatically safe.
 *
 * This is the highest-value gap. The current checker treats the presence of an
 * index as proof a read is bounded, but an index narrows WHICH rows are read,
 * never HOW MANY. `by_property` on a property with ten thousand jobs reads ten
 * thousand rows.
 */
export const unboundedIndexCollect = {
  id: "unbounded-index-collect",
  check(chain) {
    if (!chain.has("collect")) return [];
    if (!chain.has("withIndex") && !chain.has("withSearchIndex")) return [];
    if (isBounded(chain)) return [];
    return [
      {
        message:
          `.withIndex(...).collect() reads the whole range. An index chooses ` +
          `which rows are read, not how many. Add .take(cap) or paginate.`,
      },
    ];
  },
};

/**
 * Counting by reading.
 *
 * `.collect().length` reads every matching document to produce one number, and
 * it is the shape R8 forbids and nothing enforces.
 */
export const scanToCount = {
  id: "scan-to-count",
  check(chain) {
    if (!chain.has("collect")) return [];
    if (!chain.uses.has("length")) return [];
    return [
      {
        message:
          `.collect().length reads every matching document to produce a count. ` +
          `Keep a denormalised counter, or bound the read if the ceiling is small.`,
      },
    ];
  },
};

/**
 * Capping after the read has already happened.
 *
 * `.collect().slice(0, 100)` reads everything and throws most of it away. The
 * cost is paid before the slice runs.
 */
export const postCollectCap = {
  id: "post-collect-cap",
  check(chain) {
    if (!chain.has("collect")) return [];
    if (!chain.uses.has("slice")) return [];
    return [
      {
        message:
          `.collect().slice(...) reads every row before discarding most of them. ` +
          `Move the cap into the read with .take(n).`,
      },
    ];
  },
};

/**
 * A caller-chosen limit is not a limit.
 *
 * `.take(args.limit)` lets whoever calls the function decide how much of the
 * database to read. It is only a bound once it is clamped.
 */
export const dynamicLargeTake = {
  id: "dynamic-large-take",
  check(chain, { ts }) {
    const call = chain.find("take");
    if (!call || call.args.length === 0) return [];
    const arg = call.args[0];
    // A literal is fine here; `giant-take` in the v1 checker judges its size.
    if (ts.isNumericLiteral(arg)) return [];
    const text = arg.getText();
    // Clamped forms are the point of the rule, so recognise them.
    if (/\bMath\s*\.\s*min\s*\(/.test(text)) return [];
    if (/\?\?|\|\||\bclamp\b/.test(text) && /\d/.test(text)) return [];
    if (/^[A-Z][A-Z0-9_]*$/.test(text)) return [];
    return [
      {
        message:
          `.take(${text}) is bounded by the caller, not by you. Clamp it: ` +
          `Math.min(${text} ?? DEFAULT, HARD_CAP).`,
      },
    ];
  },
};

function literal(ts, node) {
  if (!node) return null;
  return ts.isStringLiteral(node) ? node.text : null;
}

export const rules = [
  indexWithoutRange,
  unboundedIndexCollect,
  scanToCount,
  postCollectCap,
  dynamicLargeTake,
];
