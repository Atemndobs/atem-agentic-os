/**
 * The ratchet.
 *
 * v1 recorded a count per file per rule and failed when a count rose. Removing
 * one violation and adding another passed, so green meant "the count did not
 * rise" rather than "nothing new appeared".
 *
 * v2 records fingerprints. A finding is new when its id is absent from the
 * baseline, whatever happened to the others, and a fixed finding is one whose
 * id stopped appearing.
 */

import fs from "node:fs";

/** Read a baseline, tolerating absence: a repository adopting has none yet. */
export function loadBaseline(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      version: parsed.version ?? 2,
      guard: parsed.guard ?? null,
      findings: parsed.findings ?? {},
      exceptions: parsed.exceptions ?? {},
    };
  } catch {
    return { version: 2, guard: null, findings: {}, exceptions: {} };
  }
}

export function saveBaseline(file, { guard, findings }) {
  const body = {
    version: 2,
    guard,
    // Sorted so a re-run produces the same bytes and a diff shows only what
    // actually changed.
    findings: Object.fromEntries(
      [...findings]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((f) => [
          f.id,
          { rule: f.rule, file: f.file, scope: f.scope, line: f.line },
        ]),
    ),
  };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * Compare a scan against a baseline.
 *
 * `now` is when the run happens, passed in rather than read, so a test can put
 * an exception's expiry on either side of it without waiting.
 */
export function compare({ findings, baseline, now = Date.now() }) {
  const known = new Set(Object.keys(baseline.findings));
  const seen = new Set(findings.map((f) => f.id));

  const added = findings.filter((f) => !known.has(f.id));
  const fixed = [...known].filter((id) => !seen.has(id));

  // An exception is a decision with an expiry date. Without one it is a
  // permanent hole that nobody revisits, which is how a baseline becomes the
  // standard rather than a record of debt.
  const expired = [];
  const excused = new Set();
  for (const f of added) {
    const ex = baseline.exceptions[f.id];
    if (!ex) continue;
    const until = Date.parse(ex.until ?? "");
    if (Number.isFinite(until) && until >= now) excused.add(f.id);
    else expired.push({ ...f, exception: ex });
  }

  const blocking = added.filter((f) => !excused.has(f.id));

  return {
    added: blocking,
    excused: added.filter((f) => excused.has(f.id)),
    expired,
    fixed,
    ok: blocking.length === 0 && expired.length === 0,
  };
}

/** What a human should read when the check fails. */
export function formatReport(result, { mode = "enforce" } = {}) {
  const lines = [];
  if (result.added.length > 0) {
    lines.push(`${result.added.length} new finding(s):`);
    for (const f of result.added.slice(0, 20)) {
      lines.push(`  ${f.file}:${f.line}  ${f.rule}  (${f.scope})`);
      lines.push(`    ${f.message}`);
    }
    if (result.added.length > 20) {
      lines.push(`  ... and ${result.added.length - 20} more`);
    }
  }
  if (result.expired.length > 0) {
    lines.push(`${result.expired.length} expired exception(s):`);
    for (const f of result.expired) {
      lines.push(`  ${f.file}:${f.line}  ${f.rule}  expired ${f.exception.until}`);
    }
  }
  if (result.fixed.length > 0) {
    lines.push(
      `${result.fixed.length} baselined finding(s) no longer present. ` +
        `Run with --update-baseline to ratchet down.`,
    );
  }
  if (result.ok && result.added.length === 0) lines.push("No new findings.");
  if (mode === "audit") {
    lines.push("Audit mode: reporting only, not failing.");
  }
  return lines.join("\n");
}
