/**
 * The ratchet's own tests.
 *
 * The first of these is the loophole that motivated v2: swap one violation for
 * another and v1 passes, because it compares counts.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const SCANNER = path.join(__dirname, "..", "guardrails", "convex", "scanner");
const load = () => import(path.join(SCANNER, "baseline.mjs"));

const finding = (id, over = {}) => ({
  id,
  rule: "unbounded-index-collect",
  file: "convex/example.ts",
  scope: "listJobs",
  line: 10,
  message: "…",
  ...over,
});

const baselineOf = (ids, exceptions = {}) => ({
  version: 2,
  guard: "0.1.0",
  findings: Object.fromEntries(ids.map((id) => [id, { rule: "r", file: "f" }])),
  exceptions,
});

test("a swapped violation fails, which is the whole point of v2", async () => {
  const { compare } = await load();
  // One baselined finding removed, a different one introduced. The count is
  // unchanged, so v1 passed this.
  const result = compare({
    findings: [finding("bbbb")],
    baseline: baselineOf(["aaaa"]),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.added.map((f) => f.id), ["bbbb"]);
  assert.deepEqual(result.fixed, ["aaaa"]);
});

test("an unchanged repository passes", async () => {
  const { compare } = await load();
  const result = compare({
    findings: [finding("aaaa"), finding("bbbb")],
    baseline: baselineOf(["aaaa", "bbbb"]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.added.length, 0);
});

test("fixing a finding passes and is reported, not silently absorbed", async () => {
  const { compare } = await load();
  const result = compare({
    findings: [finding("aaaa")],
    baseline: baselineOf(["aaaa", "bbbb"]),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.fixed, ["bbbb"]);
});

test("a live exception excuses a new finding", async () => {
  const { compare } = await load();
  const result = compare({
    findings: [finding("cccc")],
    baseline: baselineOf([], {
      cccc: { until: "2099-01-01", reason: "migration, ends with the backfill" },
    }),
    now: Date.parse("2026-09-08"),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.excused.map((f) => f.id), ["cccc"]);
});

test("an expired exception fails rather than quietly persisting", async () => {
  const { compare } = await load();
  // An exception with no end date is a permanent hole nobody revisits. This is
  // what stops the baseline becoming the standard.
  const result = compare({
    findings: [finding("cccc")],
    baseline: baselineOf([], {
      cccc: { until: "2026-01-01", reason: "temporary" },
    }),
    now: Date.parse("2026-09-08"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.expired.length, 1);
});

test("an exception without an expiry does not excuse anything", async () => {
  const { compare } = await load();
  const result = compare({
    findings: [finding("cccc")],
    baseline: baselineOf([], { cccc: { reason: "we like it" } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.expired.length, 1);
});

test("a repository with no baseline reports every finding as new", async () => {
  const { compare, loadBaseline } = await load();
  const baseline = loadBaseline("/nonexistent/convex-cost-baseline.json");
  const result = compare({ findings: [finding("aaaa")], baseline });
  assert.equal(result.ok, false);
  assert.equal(result.added.length, 1);
});

test("saving a baseline is stable, so a re-run shows an empty diff", async () => {
  const { saveBaseline, loadBaseline } = await load();
  const os = require("node:os");
  const fs = require("node:fs");
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "guard-")),
    "convex-cost-baseline.json",
  );
  const findings = [finding("bbbb"), finding("aaaa")];
  saveBaseline(file, { guard: "0.1.0", findings });
  const first = fs.readFileSync(file, "utf8");
  saveBaseline(file, { guard: "0.1.0", findings: [...findings].reverse() });
  assert.equal(fs.readFileSync(file, "utf8"), first);
  assert.equal(Object.keys(loadBaseline(file).findings).length, 2);
});
