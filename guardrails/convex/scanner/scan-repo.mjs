/**
 * Scan one repository's convex/ directory.
 *
 * This is the piece that gets vendored. It takes a repository root, resolves
 * that repository's own TypeScript, and reports fingerprinted findings.
 *
 *   node scan-repo.mjs <repoRoot> [--json]
 */

import fs from "node:fs";
import path from "node:path";
import { loadTypeScript, scanSource } from "./engine.mjs";
import { rules } from "./rules/index.mjs";
import { fingerprint } from "./fingerprint.mjs";

/** Every .ts under convex/, minus the generated tree and tests. */
export function convexFiles(repoRoot) {
  const root = path.join(repoRoot, "convex");
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "_generated" || e.name === "node_modules") continue;
        walk(full);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

export function scanRepo(repoRoot) {
  const ts = loadTypeScript(repoRoot);
  const findings = [];
  for (const file of convexFiles(repoRoot)) {
    const rel = path.relative(repoRoot, file);
    const sourceText = fs.readFileSync(file, "utf8");
    for (const f of scanSource({
      ts,
      filePath: rel,
      sourceText,
      rules,
      schema: null,
    })) {
      findings.push({
        ...f,
        id: fingerprint({
          file: rel,
          scope: f.scope,
          rule: f.rule,
          chain: f.chain,
        }),
      });
    }
  }
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = path.resolve(process.argv[2] ?? ".");
  const findings = scanRepo(repoRoot);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ findings }, null, 2));
  } else {
    const byRule = new Map();
    for (const f of findings) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
    for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1])) {
      console.log(`${String(n).padStart(5)}  ${rule}`);
    }
    console.log(`${String(findings.length).padStart(5)}  total`);
    console.log(
      `${String(new Set(findings.map((f) => f.id)).size).padStart(5)}  distinct fingerprints`,
    );
  }
}
