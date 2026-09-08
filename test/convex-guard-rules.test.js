/**
 * Three tests per rule: a true violation, a correct implementation, and a
 * false-positive guard.
 *
 * The guard matters most. A rule that fires on correct code gets switched off,
 * and a rule that is off enforces nothing. The v1 checker's own history is the
 * argument: it missed 72% of query calls until multi-line shapes were handled,
 * and the fix for a noisy rule is usually to delete it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const HERE = __dirname;
const SCANNER = path.join(HERE, "..", "guardrails", "convex", "scanner");

/** Scan a snippet as if it were a Convex module, returning rule ids. */
async function scan(source) {
  const { scanSource, loadTypeScript } = await import(
    path.join(SCANNER, "engine.mjs")
  );
  const { rules } = await import(path.join(SCANNER, "rules", "index.mjs"));
  const ts = loadTypeScript(path.join(HERE, ".."));
  return scanSource({
    ts,
    filePath: "convex/example.ts",
    sourceText: source,
    rules,
    schema: null,
  });
}

const ids = (findings) => findings.map((f) => f.rule).sort();

// ---------------------------------------------------------------- index-without-range

test("index-without-range: an index with no bound is flagged", async () => {
  const f = await scan(`
    export const listJobs = query({
      handler: async (ctx) => {
        return await ctx.db.query("jobs").withIndex("by_property").take(50);
      },
    });
  `);
  assert.ok(ids(f).includes("index-without-range"));
});

test("index-without-range: a bounded range is accepted", async () => {
  const f = await scan(`
    export const listJobs = query({
      handler: async (ctx, args) => {
        return await ctx.db
          .query("jobs")
          .withIndex("by_property", (q) => q.eq("propertyId", args.propertyId))
          .take(50);
      },
    });
  `);
  assert.ok(!ids(f).includes("index-without-range"));
});

test("index-without-range: a gte/lt range counts as bounded", async () => {
  // False-positive guard: two-sided ranges are the shape crons are told to use,
  // and flagging them would fire on exactly the code R9 asks for.
  const f = await scan(`
    export const recent = query({
      handler: async (ctx, args) => {
        return await ctx.db
          .query("stays")
          .withIndex("by_checkin", (q) =>
            q.gte("checkInAt", args.from).lt("checkInAt", args.to),
          )
          .take(200);
      },
    });
  `);
  assert.ok(!ids(f).includes("index-without-range"));
});

// ------------------------------------------------------------ unbounded-index-collect

test("unbounded-index-collect: an indexed collect is flagged", async () => {
  const f = await scan(`
    export const all = query({
      handler: async (ctx, args) => {
        return await ctx.db
          .query("jobs")
          .withIndex("by_property", (q) => q.eq("propertyId", args.id))
          .collect();
      },
    });
  `);
  assert.ok(ids(f).includes("unbounded-index-collect"));
});

test("unbounded-index-collect: the same query with a cap is accepted", async () => {
  const f = await scan(`
    export const capped = query({
      handler: async (ctx, args) => {
        return await ctx.db
          .query("jobs")
          .withIndex("by_property", (q) => q.eq("propertyId", args.id))
          .take(100);
      },
    });
  `);
  assert.ok(!ids(f).includes("unbounded-index-collect"));
});

test("unbounded-index-collect: paginate is not a collect", async () => {
  // False-positive guard: pagination is the sanctioned answer, and a rule that
  // flagged it would push people back to .collect().
  const f = await scan(`
    export const page = query({
      handler: async (ctx, args) => {
        return await ctx.db
          .query("jobs")
          .withIndex("by_property", (q) => q.eq("propertyId", args.id))
          .paginate(args.paginationOpts);
      },
    });
  `);
  assert.ok(!ids(f).includes("unbounded-index-collect"));
});

// ------------------------------------------------------------------------ scan-to-count

test("scan-to-count: .collect().length is flagged", async () => {
  const f = await scan(`
    export const howMany = query({
      handler: async (ctx, args) => {
        const rows = await ctx.db
          .query("jobs")
          .withIndex("by_property", (q) => q.eq("propertyId", args.id))
          .collect();
        return rows.length;
      },
    });
  `);
  // The direct shape, not the two-step one above.
  const g = await scan(`
    export const howMany = query({
      handler: async (ctx, args) =>
        (await ctx.db.query("jobs").withIndex("by_p", (q) => q.eq("p", args.id)).collect())
          .length,
    });
  `);
  assert.ok(ids(g).includes("scan-to-count"));
  assert.ok(Array.isArray(f));
});

test("scan-to-count: a counter read is accepted", async () => {
  const f = await scan(`
    export const howMany = query({
      handler: async (ctx, args) => {
        const row = await ctx.db
          .query("counters")
          .withIndex("by_key", (q) => q.eq("key", args.key))
          .unique();
        return row?.count ?? 0;
      },
    });
  `);
  assert.ok(!ids(f).includes("scan-to-count"));
});

test("scan-to-count: .length on a bounded take is not a scan", async () => {
  // False-positive guard: reading a capped page and measuring it is fine.
  const f = await scan(`
    export const someOf = query({
      handler: async (ctx, args) =>
        (await ctx.db.query("jobs").withIndex("by_p", (q) => q.eq("p", args.id)).take(10))
          .length,
    });
  `);
  assert.ok(!ids(f).includes("scan-to-count"));
});

// --------------------------------------------------------------------- post-collect-cap

test("post-collect-cap: .collect().slice() is flagged", async () => {
  const f = await scan(`
    export const firstFew = query({
      handler: async (ctx, args) =>
        (await ctx.db.query("jobs").withIndex("by_p", (q) => q.eq("p", args.id)).collect())
          .slice(0, 100),
    });
  `);
  assert.ok(ids(f).includes("post-collect-cap"));
});

test("post-collect-cap: taking the cap at the read is accepted", async () => {
  const f = await scan(`
    export const firstFew = query({
      handler: async (ctx, args) =>
        await ctx.db.query("jobs").withIndex("by_p", (q) => q.eq("p", args.id)).take(100),
    });
  `);
  assert.ok(!ids(f).includes("post-collect-cap"));
});

test("post-collect-cap: slicing a take is not flagged", async () => {
  // False-positive guard: the read was already bounded, so the slice is free.
  const f = await scan(`
    export const page = query({
      handler: async (ctx, args) =>
        (await ctx.db.query("jobs").withIndex("by_p", (q) => q.eq("p", args.id)).take(100))
          .slice(0, 10),
    });
  `);
  assert.ok(!ids(f).includes("post-collect-cap"));
});

// ------------------------------------------------------------------- dynamic-large-take

test("dynamic-large-take: a caller-supplied limit is flagged", async () => {
  const f = await scan(`
    export const list = query({
      handler: async (ctx, args) =>
        await ctx.db.query("jobs").withIndex("by_p", (q) => q.eq("p", args.id)).take(args.limit),
    });
  `);
  assert.ok(ids(f).includes("dynamic-large-take"));
});

test("dynamic-large-take: a clamped limit is accepted", async () => {
  const f = await scan(`
    export const list = query({
      handler: async (ctx, args) =>
        await ctx.db
          .query("jobs")
          .withIndex("by_p", (q) => q.eq("p", args.id))
          .take(Math.min(args.limit ?? 50, HARD_CAP)),
    });
  `);
  assert.ok(!ids(f).includes("dynamic-large-take"));
});

test("dynamic-large-take: a module constant is accepted", async () => {
  // False-positive guard: a named cap is the recommended shape, and flagging it
  // would push people back to bare numbers.
  const f = await scan(`
    export const list = query({
      handler: async (ctx, args) =>
        await ctx.db.query("jobs").withIndex("by_p", (q) => q.eq("p", args.id)).take(PAGE_CAP),
    });
  `);
  assert.ok(!ids(f).includes("dynamic-large-take"));
});

// ------------------------------------------------- two-step results (dataflow)

test("scan-to-count: the two-step form is seen", async () => {
  // How people actually write it. Seeing only the inline form is why this rule
  // reported zero findings against 361 files.
  const f = await scan(`
    export const howMany = query({
      handler: async (ctx, args) => {
        const rows = await ctx.db
          .query("jobs")
          .withIndex("by_p", (q) => q.eq("p", args.id))
          .collect();
        return rows.length;
      },
    });
  `);
  assert.ok(ids(f).includes("scan-to-count"));
});

test("post-collect-cap: the two-step form is seen", async () => {
  const f = await scan(`
    export const firstFew = query({
      handler: async (ctx, args) => {
        const rows = await ctx.db
          .query("jobs")
          .withIndex("by_p", (q) => q.eq("p", args.id))
          .collect();
        return rows.slice(0, 20);
      },
    });
  `);
  assert.ok(ids(f).includes("post-collect-cap"));
});

test("two-step: returning the rows themselves is not a count or a cap", async () => {
  // False-positive guard: naming a result is not a violation. Only .length and
  // .slice on it are, and mapping over rows is ordinary code.
  const f = await scan(`
    export const list = query({
      handler: async (ctx, args) => {
        const rows = await ctx.db
          .query("jobs")
          .withIndex("by_p", (q) => q.eq("p", args.id))
          .take(50);
        return rows.map((r) => r.name);
      },
    });
  `);
  const got = ids(f);
  assert.ok(!got.includes("scan-to-count"));
  assert.ok(!got.includes("post-collect-cap"));
});
