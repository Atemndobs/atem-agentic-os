#!/usr/bin/env node
/**
 * Split the suite into what CI gates and what it merely reports.
 *
 * The quarantine list lives in test/QUARANTINE.md, in a table a person reads,
 * and is parsed from there. The workflow does not keep its own copy: two lists
 * drift, and the one in YAML is the one nobody looks at.
 *
 *   node scripts/test-partition.mjs gated        files CI gates
 *   node scripts/test-partition.mjs quarantined  files CI reports only
 *
 * Exits non-zero if the manifest names a file that does not exist, so deleting
 * or renaming a quarantined test cannot leave a stale row behind.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function quarantinedFiles() {
  const manifest = path.join(root, "test", "QUARANTINE.md");
  let text;
  try {
    text = fs.readFileSync(manifest, "utf8");
  } catch {
    return [];
  }
  // Table rows: | `test/x.test.js` | 12 | reason |
  const files = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\|\s*`(test\/[^`]+\.test\.js)`\s*\|/);
    if (m) files.push(m[1]);
  }
  return files;
}

export function allTestFiles() {
  return fs
    .readdirSync(path.join(root, "test"))
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => `test/${f}`)
    .sort();
}

function main() {
  const mode = process.argv[2];
  const quarantined = quarantinedFiles();
  const all = allTestFiles();

  const missing = quarantined.filter((f) => !all.includes(f));
  if (missing.length > 0) {
    console.error(
      `QUARANTINE.md names ${missing.length} file(s) that do not exist: ${missing.join(", ")}`,
    );
    process.exit(1);
  }

  const gated = all.filter((f) => !quarantined.includes(f));
  const out = mode === "quarantined" ? quarantined : gated;
  console.log(out.join(" "));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
