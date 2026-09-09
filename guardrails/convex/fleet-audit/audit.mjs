/**
 * The fleet verbs: inventory, audit, status.
 *
 * These read. `adopt` and `upgrade` write into other people's repositories and
 * live separately, because a command that opens eleven pull requests should not
 * share a code path with one that prints a table.
 */

import path from "node:path";
import { surveyFleet } from "./fleet.mjs";
import { scanRepo } from "../scanner/scan-repo.mjs";
import { GUARD_VERSION } from "../scanner/cli.mjs";

/** Default roots: where this machine keeps its work. */
export function defaultRoots(home = process.env.HOME) {
  return [path.join(home ?? "", "sites")];
}

export function inventory(roots) {
  return surveyFleet(roots).map((r) => ({
    name: r.name,
    files: r.convex.files,
    convexVersion: r.convexVersion,
    adopted: r.adopted,
    mode: r.mode,
    guard: r.guard,
    baselineCount: r.baselineCount,
    scannable: r.scannable,
    mirrorOf: r.mirrorOf ?? null,
    dir: r.dir,
  }));
}

/**
 * Scan every scannable repository and report findings with drift.
 *
 * A mirror is scanned and reported, and excluded from the fleet TOTAL. Both
 * halves matter: hiding it would make a mirrored backend look unguarded, and
 * counting it inflated the first fleet number I produced by 42%.
 */
export function audit(roots, { scan = scanRepo } = {}) {
  const repos = surveyFleet(roots);
  const rows = [];

  for (const r of repos) {
    const row = {
      name: r.name,
      files: r.convex.files,
      adopted: r.adopted,
      mode: r.mode,
      mirrorOf: r.mirrorOf ?? null,
      drift: [],
    };

    if (r.convex.files === 0) row.drift.push("no Convex source");
    if (!r.adopted) row.drift.push("not adopted");
    if (r.adopted && !r.vendored) row.drift.push("config without a vendored scanner");
    if (r.adopted && !r.hasWorkflow) row.drift.push("no CI workflow: nothing enforces this");
    if (r.guard && r.guard !== GUARD_VERSION) {
      row.drift.push(`guard ${r.guard}, standard is ${GUARD_VERSION}`);
    }
    if (r.baselineGuard && r.guard && r.baselineGuard !== r.guard) {
      row.drift.push(`baseline written by guard ${r.baselineGuard}`);
    }

    if (!r.scannable) {
      row.status = "unknown";
      row.drift.push("cannot scan: no TypeScript installed");
      rows.push(row);
      continue;
    }

    try {
      const findings = scan(r.dir);
      row.status = "scanned";
      row.total = findings.length;
      row.byRule = {};
      for (const f of findings) row.byRule[f.rule] = (row.byRule[f.rule] ?? 0) + 1;
      // The one number a maintainer should act on first.
      row.worstFile = topFile(findings);
    } catch (err) {
      row.status = "error";
      row.error = String(err.message ?? err).slice(0, 120);
    }
    rows.push(row);
  }

  const counted = rows.filter((r) => r.status === "scanned" && !r.mirrorOf);
  const totals = {};
  for (const r of counted) {
    for (const [rule, n] of Object.entries(r.byRule ?? {})) {
      totals[rule] = (totals[rule] ?? 0) + n;
    }
  }

  return {
    guard: GUARD_VERSION,
    repos: rows,
    fleet: {
      repositories: rows.length,
      scanned: rows.filter((r) => r.status === "scanned").length,
      unknown: rows.filter((r) => r.status === "unknown").length,
      mirrors: rows.filter((r) => r.mirrorOf).length,
      adopted: rows.filter((r) => r.adopted).length,
      enforcing: rows.filter((r) => r.mode === "enforce").length,
      findings: Object.values(totals).reduce((a, b) => a + b, 0),
      byRule: totals,
    },
  };
}

function topFile(findings) {
  const byFile = {};
  for (const f of findings) byFile[f.file] = (byFile[f.file] ?? 0) + 1;
  const ranked = Object.entries(byFile).sort((a, b) => b[1] - a[1]);
  return ranked.length > 0 ? { file: ranked[0][0], findings: ranked[0][1] } : null;
}

/** One repository, in enough detail to act on. */
export function status(dir, { scan = scanRepo } = {}) {
  const repos = surveyFleet([path.dirname(path.resolve(dir))]);
  const r = repos.find((x) => path.resolve(x.dir) === path.resolve(dir));
  if (!r) return { error: `No Convex repository at ${dir}` };
  const out = { ...r, guardStandard: GUARD_VERSION };
  if (r.scannable) {
    const findings = scan(r.dir);
    out.findings = findings.length;
    out.byRule = {};
    for (const f of findings) out.byRule[f.rule] = (out.byRule[f.rule] ?? 0) + 1;
    out.byFile = Object.entries(
      findings.reduce((acc, f) => ({ ...acc, [f.file]: (acc[f.file] ?? 0) + 1 }), {}),
    )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([file, n]) => ({ file, findings: n }));
  }
  return out;
}
