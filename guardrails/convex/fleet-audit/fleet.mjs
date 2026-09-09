/**
 * The fleet: which repositories hold Convex code, what each is holding itself
 * to, and where they disagree with the standard.
 *
 * Three things make a naive walk of ~/sites wrong, and each was measured rather
 * than guessed:
 *
 *   Worktrees. 26 directories contained a convex/ tree and only 11 were
 *   distinct repositories. `git rev-parse --git-common-dir` groups them.
 *
 *   Mirrors. jna-cleaners-app's convex/ is a copy of opscentral-admin's,
 *   maintained by a sync script. Scanned naively it reports the same 451
 *   findings twice and inflates every fleet number by 42%.
 *
 *   Unscannable repositories. The scanner resolves the host's TypeScript, so a
 *   repository with no node_modules cannot be scanned. That is a fact to report,
 *   not an error to throw: "we do not know" and "there is nothing wrong" must
 *   not look the same in a fleet report.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

/** Directories to skip when walking for repositories. */
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "graphify-out"]);

/**
 * Paths that contain a convex/ tree without being a repository to guard.
 *
 * The first fleet run reported "guardrails" as a repository with 5 findings.
 * That was this scanner's own test fixture, whose violations are deliberate.
 * A fleet report that includes its own fixtures is measuring itself.
 */
const NOT_A_REPO = [
  /\/fixtures\//,
  /\/__tests__\//,
  /\/\.abandoned/,
  /\/repo-template\//,
  // `.agents/skills/convex` is a SKILL named convex, not a backend. Matching on
  // the directory name alone reported four of those as repositories.
  /\/skills\//,
  // Backups of repositories that have since moved on.
  /\/archive\//,
  // This capability's own source: guardrails/convex is the standard, not a
  // backend held to it.
  /\/guardrails\//,
];

/**
 * Evidence that a convex/ directory is a deployed backend.
 *
 * Matching the directory NAME alone reported eleven phantoms: skill folders
 * called convex, a `lib/convex` client helper, a `tests/convex` fixture, this
 * repository's own guardrails source, and two archived backups. A real backend
 * declares the dependency, or has generated bindings, or a convex.json.
 */
function looksLikeBackend(dir) {
  const pkg = readJson(path.join(dir, "package.json"));
  const dep = pkg?.dependencies?.convex ?? pkg?.devDependencies?.convex;
  if (dep) return true;
  if (fs.existsSync(path.join(dir, "convex.json"))) return true;
  return fs.existsSync(path.join(dir, "convex", "_generated"));
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Every directory under `roots` that has a convex/ tree, one level deep. */
export function findConvexDirs(roots, depth = 3) {
  const found = [];
  const walk = (dir, left) => {
    if (left < 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
    if (
      names.has("convex") &&
      !NOT_A_REPO.some((re) => re.test(`${dir}/`)) &&
      looksLikeBackend(dir)
    ) {
      found.push(dir);
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      walk(path.join(dir, e.name), left - 1);
    }
  };
  for (const r of roots) walk(r, depth);
  return found;
}

/** A stable hash of the Convex source, so a mirrored backend is recognisable. */
export function convexTreeHash(repoRoot) {
  const root = path.join(repoRoot, "convex");
  const files = [];
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
      } else if (e.name.endsWith(".ts")) {
        files.push(full);
      }
    }
  };
  walk(root);
  files.sort();
  const h = createHash("sha256");
  const digests = new Set();
  for (const f of files) {
    const body = fs.readFileSync(f);
    h.update(path.relative(root, f));
    h.update(body);
    digests.add(createHash("sha256").update(body).digest("hex").slice(0, 16));
  }
  return { hash: h.digest("hex").slice(0, 16), files: files.length, digests };
}

/** Does this repository run a script that copies a backend in from elsewhere? */
function hasSyncScript(dir) {
  const pkg = readJson(path.join(dir, "package.json"));
  const scripts = Object.entries(pkg?.scripts ?? {});
  return scripts.some(
    ([name, body]) =>
      /sync.*convex|convex.*sync/i.test(name) || /sync-convex-backend/i.test(String(body)),
  );
}

/** Share of the smaller tree's files whose content appears in the larger. */
function fileOverlap(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const d of small) if (large.has(d)) shared += 1;
  return shared / small.size;
}

function hasTypeScript(repoRoot) {
  try {
    createRequire(path.join(repoRoot, "package.json")).resolve("typescript");
    return true;
  } catch {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** What one repository is holding itself to. */
export function inspectRepo(dir) {
  const commonDir = git(dir, ["rev-parse", "--git-common-dir"]);
  const identity = commonDir
    ? path.resolve(dir, commonDir)
    : path.resolve(dir); // not a git repo: it is its own identity
  const remote = git(dir, ["remote", "get-url", "origin"]);
  const config = readJson(path.join(dir, ".convex-cost.json"));
  const baseline = readJson(path.join(dir, ".convex-cost-baseline.json"));
  const pkg = readJson(path.join(dir, "package.json"));

  let primary = false;
  try {
    primary = fs.statSync(path.join(dir, ".git")).isDirectory();
  } catch {
    primary = false;
  }

  const topLevel = git(dir, ["rev-parse", "--show-toplevel"]);
  const sub = topLevel && path.resolve(topLevel) !== path.resolve(dir)
    ? path.relative(topLevel, dir)
    : null;

  return {
    dir,
    // A nested app reads as "repo/app", so two apps in one repository do not
    // both appear under the repository's name and look like duplicates.
    name: sub ? `${path.basename(topLevel)}/${sub}` : path.basename(dir),
    identity: sub ? `${identity}::${sub}` : identity,
    primary,
    remote,
    convex: convexTreeHash(dir),
    convexVersion: pkg?.dependencies?.convex ?? pkg?.devDependencies?.convex ?? null,
    scannable: hasTypeScript(dir),
    adopted: Boolean(config),
    mode: config?.mode ?? null,
    guard: config?.guard ?? null,
    baselineCount: baseline ? Object.keys(baseline.findings ?? {}).length : null,
    baselineGuard: baseline?.guard ?? null,
    hasWorkflow: fs.existsSync(path.join(dir, ".github/workflows/convex-cost.yml")),
    vendored: fs.existsSync(path.join(dir, ".convex-guard/cli.mjs")),
  };
}

/**
 * The fleet, deduplicated.
 *
 * One entry per distinct git repository, preferring the checkout whose path is
 * shortest, which is the primary rather than a task worktree. Mirrors are kept
 * but flagged, because a mirror is a real repository with a real deployment;
 * only its FINDINGS are duplicates, and a report that hides it entirely would
 * make a mirrored backend look unguarded.
 */
export function surveyFleet(roots) {
  const byIdentity = new Map();
  for (const dir of findConvexDirs(roots)) {
    const info = inspectRepo(dir);
    const seen = byIdentity.get(info.identity);
    // Prefer the PRIMARY checkout over a task worktree. A worktree's .git is a
    // file pointing elsewhere; the primary's is a directory. Choosing by path
    // length picked "opscentral-admin-occ" over the real checkout, which reads
    // as a different repository to anyone scanning the report.
    if (!seen || (info.primary && !seen.primary) ||
        (info.primary === seen.primary && info.dir.length < seen.dir.length)) {
      byIdentity.set(info.identity, info);
    }
  }

  // A directory called convex with no TypeScript in it is not a Convex backend.
  // Requiring evidence, rather than a name, removes every phantom entry the
  // first run produced.
  const repos = [...byIdentity.values()]
    .filter((r) => r.convex.files > 0)
    .sort((a, b) => b.convex.files - a.convex.files);

  // Mirror detection by OVERLAP, not by an identical hash.
  //
  // The first version compared exact tree hashes and found no mirrors, while
  // reporting the same 451 findings for two repositories. The cleaners app's
  // copy was a few commits behind, so a byte-comparison said "different" about
  // two trees that are the same backend. Overlap of file content is what
  // actually answers the question.
  for (const r of repos) r.mirrorOf = null;
  for (let i = 0; i < repos.length; i += 1) {
    for (let j = i + 1; j < repos.length; j += 1) {
      const a = repos[i];
      const b = repos[j];
      if (b.mirrorOf || a.convex.files < 20 || b.convex.files < 20) continue;
      const overlap = fileOverlap(a.convex.digests, b.convex.digests);
      if (overlap < 0.9) continue;
      // Which one is the copy is not decided by file count. The owner is the
      // repository that adopted the guard, or failing that the one that is not
      // named by a sync script. Calling opscentral-admin a mirror of the
      // cleaners app inverted the ownership the repositories themselves
      // document.
      const [owner, copy] = a.adopted && !b.adopted ? [a, b]
        : b.adopted && !a.adopted ? [b, a]
        : hasSyncScript(b.dir) ? [a, b]
        : hasSyncScript(a.dir) ? [b, a]
        : [a, b];
      copy.mirrorOf = owner.name;
    }
  }

  return repos;
}
