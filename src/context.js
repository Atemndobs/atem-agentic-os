// Project context auto-discovery for handoffs.
//
// Today's handoff prompt links 7 session files (brief, state, handoff,
// next, decisions, log, validation). That's the *task* — but the next
// provider also benefits from seeing the *project's* purpose + plan.
// This module walks the repo looking for those docs and returns a
// structured summary the handoff prompt can embed.
//
// Heuristic-first. We're pattern-matching common conventions across
// the GSD/.planning/, ADR, and docs/* communities. False positives are
// fine — provider will pick what it needs.
//
// Pure: takes a repoRoot string, returns a plain object. No process,
// no env, no global state.

const fs = require('node:fs');
const path = require('node:path');

// First-match-wins set of files that describe the project's purpose.
// Order matters — the most opinionated planning docs win over README.
const PURPOSE_CANDIDATES = [
  'docs/action-plan.md',
  'docs/PROJECT.md',
  'PROJECT.md',
  'docs/ROADMAP.md',
  'ROADMAP.md',
  'docs/VISION.md',
  'VISION.md',
  'docs/PLAN.md',
  'PLAN.md',
];

// Directory + glob shapes for the plural categories.
const PLAN_DIRS = [
  'docs/sub-plans',
  'docs',
  '.planning',
  '.planning/plans',
];
const PLAN_PATTERNS = [
  /^sub-plan-.*\.md$/i,
  /^PLAN\.md$/,
  /^SPEC\.md$/,
  /^plan-.*\.md$/i,
];

const RESEARCH_DIRS = [
  'docs/research',
  '.planning/research',
];
const RESEARCH_PATTERNS = [/\.md$/i];

const DECISION_DIRS = [
  'docs/decisions',
  '.planning/decisions',
  'ADR',
  'adr',
  'docs/adr',
];
const DECISION_PATTERNS = [/\.md$/i];

// Bounds: don't surface 50 docs in a handoff. Newest-by-mtime wins.
const MAX_PLANS = 4;
const MAX_RESEARCH = 4;
const MAX_DECISIONS = 5;

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function readMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

function readFirstHeading(p, maxLen = 80) {
  // Strip leading frontmatter; return first markdown heading text.
  try {
    const buf = Buffer.alloc(4096);
    const fd = fs.openSync(p, 'r');
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    let text = buf.slice(0, n).toString('utf8');
    if (text.startsWith('---')) {
      const end = text.indexOf('\n---', 3);
      if (end > 0) text = text.slice(end + 4);
    }
    const m = text.match(/^#{1,6}\s+(.+?)\s*$/m);
    if (!m) return '';
    return m[1].slice(0, maxLen);
  } catch {
    return '';
  }
}

function makeEntry(repoRoot, fullPath) {
  return {
    path: fullPath,
    rel: path.relative(repoRoot, fullPath),
    title: readFirstHeading(fullPath),
    mtimeMs: readMtime(fullPath),
  };
}

function findPurpose(repoRoot) {
  for (const rel of PURPOSE_CANDIDATES) {
    const full = path.join(repoRoot, rel);
    if (exists(full)) return makeEntry(repoRoot, full);
  }
  return null;
}

// Walk one directory (non-recursive for plans, recursive for research/
// decisions). We bound depth at 3 to avoid scanning node_modules etc.
function listDir(dir, { recursive = false, maxDepth = 3, depth = 0 } = {}) {
  if (!exists(dir)) return [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive && depth < maxDepth && !e.name.startsWith('.') && e.name !== 'node_modules') {
        out.push(...listDir(full, { recursive: true, maxDepth, depth: depth + 1 }));
      }
      continue;
    }
    out.push(full);
  }
  return out;
}

function canonical(p) {
  // realpath dedupes case-insensitive filesystems (macOS sees ADR/ and
  // adr/ as the same directory). Falls back to literal path on error.
  try { return fs.realpathSync.native(p); } catch { return p; }
}

function findInCategory(repoRoot, dirs, patterns, { max, recursive = false }) {
  const seen = new Set();
  const collected = [];
  for (const sub of dirs) {
    const dir = path.join(repoRoot, sub);
    const files = listDir(dir, { recursive });
    for (const f of files) {
      const key = canonical(f);
      if (seen.has(key)) continue;
      const name = path.basename(f);
      if (!patterns.some((re) => re.test(name))) continue;
      seen.add(key);
      collected.push(makeEntry(repoRoot, f));
    }
  }
  collected.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return collected.slice(0, max);
}

function discoverProjectContext(repoRoot) {
  if (!repoRoot || !exists(repoRoot)) {
    return { purpose: null, plans: [], research: [], decisions: [] };
  }
  return {
    purpose: findPurpose(repoRoot),
    plans: findInCategory(repoRoot, PLAN_DIRS, PLAN_PATTERNS, { max: MAX_PLANS }),
    research: findInCategory(repoRoot, RESEARCH_DIRS, RESEARCH_PATTERNS, { max: MAX_RESEARCH, recursive: true }),
    decisions: findInCategory(repoRoot, DECISION_DIRS, DECISION_PATTERNS, { max: MAX_DECISIONS, recursive: true }),
  };
}

// Render the discovered context as a markdown block for the handoff
// prompt. Returns empty string if nothing was found.
function renderProjectContextSection(context) {
  if (!context) return '';
  const sections = [];
  if (context.purpose) {
    sections.push(`### Why (project purpose)\n- \`${context.purpose.path}\`${context.purpose.title ? ` — ${context.purpose.title}` : ''}`);
  }
  if (context.plans && context.plans.length > 0) {
    const lines = context.plans.map((p) => `- \`${p.path}\`${p.title ? ` — ${p.title}` : ''}`);
    sections.push(`### Plans (what we're building, in order of recency)\n${lines.join('\n')}`);
  }
  if (context.research && context.research.length > 0) {
    const lines = context.research.map((p) => `- \`${p.path}\`${p.title ? ` — ${p.title}` : ''}`);
    sections.push(`### Research (priors and context)\n${lines.join('\n')}`);
  }
  if (context.decisions && context.decisions.length > 0) {
    const lines = context.decisions.map((p) => `- \`${p.path}\`${p.title ? ` — ${p.title}` : ''}`);
    sections.push(`### Decisions (don't relitigate)\n${lines.join('\n')}`);
  }
  if (sections.length === 0) return '';
  return [
    '## Project Context',
    'Read these for the bigger picture — task files above tell you',
    'what you are doing now, these tell you why and what comes next.',
    '',
    ...sections,
  ].join('\n');
}

module.exports = {
  discoverProjectContext,
  renderProjectContextSection,
  // Exposed for tests
  PURPOSE_CANDIDATES,
  PLAN_DIRS,
  RESEARCH_DIRS,
  DECISION_DIRS,
};
