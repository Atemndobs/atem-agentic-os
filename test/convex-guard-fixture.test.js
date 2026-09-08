/**
 * End to end over a directory tree, not a string.
 *
 * The rule tests parse snippets. This one walks a fixture repository the way it
 * walks a real one: find the files, resolve TypeScript, scan, fingerprint. It is
 * the difference between "the rule works" and "the scanner works".
 *
 * The counts are asserted exactly. A rule that stops firing should fail here
 * rather than go quiet across eleven repositories, which is the failure mode
 * this whole capability exists to prevent.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const SCANNER = path.join(__dirname, "..", "guardrails", "convex", "scanner");
const FIXTURE = path.join(SCANNER, "fixtures", "repo");

test("the scanner finds the fixture's planted violations", async () => {
  const { scanRepo } = await import(path.join(SCANNER, "scan-repo.mjs"));
  const findings = scanRepo(FIXTURE);

  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;

  assert.deepEqual(byRule, {
    // howMany both collects an unbounded range and counts it, so it is two
    // findings about one query. That is deliberate: fixing the count does not
    // fix the read.
    "unbounded-index-collect": 2,
    "index-without-range": 1,
    "scan-to-count": 1,
    "dynamic-large-take": 1,
  });
  assert.equal(findings.length, 5);
});

test("the fixture's correct query produces nothing", async () => {
  const { scanRepo } = await import(path.join(SCANNER, "scan-repo.mjs"));
  const findings = scanRepo(FIXTURE);
  assert.equal(
    findings.some((f) => f.scope === "listCapped"),
    false,
    "listCapped is bounded, clamped and mapped: it must stay quiet",
  );
});

test("every finding carries a fingerprint, and they are distinct", async () => {
  const { scanRepo } = await import(path.join(SCANNER, "scan-repo.mjs"));
  const findings = scanRepo(FIXTURE);
  assert.ok(findings.every((f) => typeof f.id === "string" && f.id.length === 16));
  assert.equal(new Set(findings.map((f) => f.id)).size, findings.length);
});

test("a second scan produces identical fingerprints", async () => {
  // The baseline is worthless if an id moves between runs, so this pins it.
  const { scanRepo } = await import(path.join(SCANNER, "scan-repo.mjs"));
  const first = scanRepo(FIXTURE).map((f) => f.id).sort();
  const second = scanRepo(FIXTURE).map((f) => f.id).sort();
  assert.deepEqual(first, second);
});
