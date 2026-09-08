/**
 * A fixture repository for the end-to-end smoke test.
 *
 * Not a sample to copy. Every query below is deliberately wrong in one of the
 * ways the rules exist to catch, so CI can prove the scanner still fires when
 * pointed at a directory tree rather than a string.
 *
 * Keep the count stable: the smoke test asserts on it, and a rule that stops
 * firing should fail here rather than go quiet in eleven repositories.
 */

import { query } from "./_generated/server";

// unbounded-index-collect: an index narrows which rows, never how many.
export const allForProperty = query({
  handler: async (ctx, args: any) =>
    await ctx.db
      .query("jobs")
      .withIndex("by_property", (q: any) => q.eq("propertyId", args.propertyId))
      .collect(),
});

// index-without-range: no bound, so the whole index is walked.
export const everything = query({
  handler: async (ctx: any) =>
    await ctx.db.query("jobs").withIndex("by_property").take(50),
});

// scan-to-count, in the two-step form people actually write.
export const howMany = query({
  handler: async (ctx: any, args: any) => {
    const rows = await ctx.db
      .query("jobs")
      .withIndex("by_property", (q: any) => q.eq("propertyId", args.propertyId))
      .collect();
    return rows.length;
  },
});

// dynamic-large-take: the caller decides how much of the table to read.
export const listSome = query({
  handler: async (ctx: any, args: any) =>
    await ctx.db
      .query("jobs")
      .withIndex("by_property", (q: any) => q.eq("propertyId", args.propertyId))
      .take(args.limit),
});

// Correct, and must stay quiet: bounded read, clamped cap, mapped result.
export const listCapped = query({
  handler: async (ctx: any, args: any) => {
    const rows = await ctx.db
      .query("jobs")
      .withIndex("by_property", (q: any) => q.eq("propertyId", args.propertyId))
      .take(Math.min(args.limit ?? 50, 200));
    return rows.map((r: any) => r.name);
  },
});
