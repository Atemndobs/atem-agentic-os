/**
 * The Convex Read-Cost Ratchet, as a repository runs it.
 *
 * This is the entry point the vendored copy exposes and CI invokes. It reads the
 * repository's own config and baseline, so the standard a repository holds
 * itself to is visible in that repository rather than only in the Harness.
 *
 *   node .convex-guard/cli.mjs                    check (CI)
 *   node .convex-guard/cli.mjs --update-baseline  accept the current findings
 *   node .convex-guard/cli.mjs --json             machine-readable
 *
 * Exit codes: 0 pass, 1 new or expired findings, 2 could not run.
 */

import fs from "node:fs";
import path from "node:path";
import { scanRepo } from "./scan-repo.mjs";
import { loadBaseline, saveBaseline, compare, formatReport } from "./baseline.mjs";

export const GUARD_VERSION = "0.1.0";

const DEFAULTS = {
  mode: "audit",
  baseline: ".convex-cost-baseline.json",
  rules: {},
};

/** The repository's config, if it has one. Absent means audit mode. */
export function loadConfig(repoRoot) {
  const file = path.join(repoRoot, ".convex-cost.json");
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function run(repoRoot, argv = []) {
  const config = loadConfig(repoRoot);
  const baselineFile = path.join(repoRoot, config.baseline);

  let findings;
  try {
    findings = scanRepo(repoRoot);
  } catch (err) {
    return { code: 2, output: String(err.message ?? err) };
  }

  // A rule switched off in config is not scanned away, it is filtered here, so
  // turning it back on needs no rescan and the config stays the only place a
  // repository states what it enforces.
  const enabled = findings.filter((f) => config.rules[f.rule] !== false);

  if (argv.includes("--update-baseline")) {
    saveBaseline(baselineFile, { guard: GUARD_VERSION, findings: enabled });
    return {
      code: 0,
      output: `Baseline written: ${enabled.length} finding(s), guard ${GUARD_VERSION}.`,
    };
  }

  const baseline = loadBaseline(baselineFile);
  const result = compare({ findings: enabled, baseline });

  if (argv.includes("--json")) {
    return { code: result.ok ? 0 : 1, output: JSON.stringify({ ...result, guard: GUARD_VERSION }, null, 2) };
  }

  const output = formatReport(result, { mode: config.mode });

  // Audit mode reports and never fails. It is how a repository adopts the
  // standard without a wall of red on day one, and how eleven repositories can
  // adopt before any of them is gated.
  if (config.mode === "audit") return { code: 0, output };
  return { code: result.ok ? 0 : 1, output };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = process.cwd();
  const { code, output } = run(repoRoot, process.argv.slice(2));
  console.log(output);
  process.exit(code);
}
