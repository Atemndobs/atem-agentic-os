/**
 * `atem guardrails convex <verb>`
 *
 *   inventory              which repositories hold Convex code, and their posture
 *   audit [--all]          scan the fleet, report findings and drift
 *   status [dir]           one repository, in enough detail to act on
 *
 * Read-only. `adopt` and `upgrade` write into repositories and are deliberately
 * not here yet: a command that opens eleven pull requests should not arrive in
 * the same change as one that prints a table.
 */

import path from "node:path";
import fs from "node:fs";
import { inventory, audit, status, defaultRoots } from "./audit.mjs";
import { surveyFleet } from "./fleet.mjs";
import { scanRepo } from "../scanner/scan-repo.mjs";
import { renderRepoReport } from "./report.mjs";
import { GUARD_VERSION } from "../scanner/cli.mjs";

const HELP = `atem guardrails convex <verb>

  inventory            Convex repositories and what each holds itself to
  audit                scan the fleet, report findings and drift
  status [dir]         one repository in detail (default: cwd)
  report               write a CONVEX-READ-COST.html report into each repository

Options
  --dry-run            report verb: print what would be written, write nothing
  --root <path>        add a search root (repeatable; default ~/sites)
  --json               machine-readable
`;

function parse(argv) {
  const roots = [];
  let json = false;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") roots.push(path.resolve(argv[++i]));
    else if (argv[i] === "--json") json = true;
    else if (argv[i] === "--all") continue; // audit is fleet-wide by nature
    else rest.push(argv[i]);
  }
  return { roots: roots.length > 0 ? roots : defaultRoots(), json, rest };
}

const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
const num = (s, n) => String(s ?? "").padStart(n);

function renderInventory(rows) {
  const lines = [
    `${pad("repository", 26)}${num("files", 6)}  ${pad("convex", 10)}${pad("adopted", 9)}${pad("mode", 8)}note`,
  ];
  for (const r of rows) {
    const note = [
      r.mirrorOf ? `mirror of ${r.mirrorOf}` : "",
      r.scannable ? "" : "no TypeScript installed",
      r.adopted && r.baselineCount != null ? `${r.baselineCount} baselined` : "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `${pad(r.name, 26)}${num(r.files, 6)}  ${pad(r.convexVersion ?? "-", 10)}${pad(r.adopted ? "yes" : "no", 9)}${pad(r.mode ?? "-", 8)}${note}`,
    );
  }
  return lines.join("\n");
}

function renderAudit(result) {
  const cols = [
    "unbounded-index-collect",
    "scan-to-count",
    "index-without-range",
    "dynamic-large-take",
    "post-collect-cap",
  ];
  const lines = [
    `${pad("repository", 26)}${num("total", 6)}  ${cols.map((c) => num(c.slice(0, 9), 10)).join("")}`,
  ];
  for (const r of result.repos) {
    if (r.status !== "scanned") {
      lines.push(`${pad(r.name, 26)}${num(r.status === "unknown" ? "?" : "err", 6)}`);
      continue;
    }
    const mark = r.mirrorOf ? " (mirror, not counted)" : "";
    lines.push(
      `${pad(r.name, 26)}${num(r.total, 6)}  ${cols.map((c) => num(r.byRule?.[c] ?? 0, 10)).join("")}${mark}`,
    );
  }
  const f = result.fleet;
  lines.push("-".repeat(84));
  lines.push(
    `${pad("FLEET (mirrors excluded)", 26)}${num(f.findings, 6)}  ${cols.map((c) => num(f.byRule?.[c] ?? 0, 10)).join("")}`,
  );
  lines.push("");
  lines.push(
    `${f.repositories} repositories, ${f.scanned} scanned, ${f.unknown} unknown, ${f.mirrors} mirrored.`,
  );
  lines.push(
    `${f.adopted} adopted, ${f.enforcing} enforcing. Guard ${result.guard}.`,
  );

  const drift = result.repos.filter((r) => r.drift.length > 0);
  if (drift.length > 0) {
    lines.push("");
    lines.push("Drift:");
    for (const r of drift) {
      for (const d of r.drift) lines.push(`  ${pad(r.name, 26)}${d}`);
    }
  }

  const worst = result.repos
    .filter((r) => r.status === "scanned" && !r.mirrorOf && r.worstFile)
    .sort((a, b) => b.worstFile.findings - a.worstFile.findings)
    .slice(0, 5);
  if (worst.length > 0) {
    lines.push("");
    lines.push("Start here, per repository:");
    for (const r of worst) {
      lines.push(`  ${pad(r.name, 26)}${r.worstFile.file} (${r.worstFile.findings})`);
    }
  }
  return lines.join("\n");
}

function renderStatus(s) {
  if (s.error) return s.error;
  const lines = [
    `${s.name}  ${s.convex.files} Convex files, convex ${s.convexVersion ?? "-"}`,
    `  adopted:   ${s.adopted ? `yes, mode ${s.mode}, guard ${s.guard}` : "no"}`,
    `  vendored:  ${s.vendored ? "yes" : "no"}`,
    `  workflow:  ${s.hasWorkflow ? "yes" : "no (nothing enforces this)"}`,
    `  baseline:  ${s.baselineCount != null ? `${s.baselineCount} fingerprints` : "none"}`,
    `  standard:  guard ${s.guardStandard}`,
  ];
  if (s.mirrorOf) lines.push(`  mirror of: ${s.mirrorOf}`);
  if (s.findings != null) {
    lines.push(`  findings:  ${s.findings}`);
    for (const [rule, n] of Object.entries(s.byRule).sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${num(n, 5)}  ${rule}`);
    }
    lines.push("  worst files:");
    for (const f of s.byFile) lines.push(`    ${num(f.findings, 5)}  ${f.file}`);
  } else {
    lines.push("  findings:  unknown (no TypeScript installed)");
  }
  return lines.join("\n");
}

export function run(argv) {
  const { roots, json, rest } = parse(argv);
  const verb = rest[0];

  if (!verb || verb === "help") return { code: 0, output: HELP };

  if (verb === "inventory") {
    const rows = inventory(roots);
    return { code: 0, output: json ? JSON.stringify(rows, null, 2) : renderInventory(rows) };
  }
  if (verb === "audit") {
    const result = audit(roots);
    return { code: 0, output: json ? JSON.stringify(result, null, 2) : renderAudit(result) };
  }
  if (verb === "report") {
    const dry = argv.includes("--dry-run");
    const written = [];
    for (const r of surveyFleet(roots)) {
      // A mirror's findings belong to the repository that owns the backend.
      // Writing the same report twice would have two teams fixing one thing.
      if (r.mirrorOf) {
        written.push({ name: r.name, skipped: `mirror of ${r.mirrorOf}` });
        continue;
      }
      if (!r.scannable) {
        written.push({ name: r.name, skipped: "no TypeScript installed" });
        continue;
      }
      const findings = scanRepo(r.dir);
      const html = renderRepoReport({
        name: r.name,
        generatedAt: new Date().toISOString().slice(0, 10),
        findings,
        guard: GUARD_VERSION,
        convexVersion: r.convexVersion,
        adopted: r.adopted,
      });
      const out = path.join(r.dir, "CONVEX-READ-COST.html");
      if (!dry) fs.writeFileSync(out, html);
      written.push({ name: r.name, path: out, findings: findings.length });
    }
    const lines = written.map((w) =>
      w.skipped
        ? `${pad(w.name, 26)}skipped: ${w.skipped}`
        : `${pad(w.name, 26)}${num(w.findings, 5)}  ${w.path}`,
    );
    lines.push("");
    lines.push(
      dry
        ? "Dry run: nothing written."
        : `${written.filter((w) => !w.skipped).length} report(s) written.`,
    );
    return { code: 0, output: json ? JSON.stringify(written, null, 2) : lines.join("\n") };
  }

  if (verb === "status") {
    const dir = path.resolve(rest[1] ?? process.cwd());
    const s = status(dir);
    return { code: s.error ? 1 : 0, output: json ? JSON.stringify(s, null, 2) : renderStatus(s) };
  }
  return { code: 1, output: `Unknown verb: ${verb}\n\n${HELP}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { code, output } = run(process.argv.slice(2));
  console.log(output);
  process.exit(code);
}
