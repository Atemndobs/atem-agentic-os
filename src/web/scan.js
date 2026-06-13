// Machine-wide planning document discovery for the `atem web` viewer.
//
// Two groups:
//   tasks    — ATEM session files, read through ~/.atem/handles/<task>/
//   projects — planning docs of every project any agent has touched on
//              this machine, discovered from agent registries (Claude
//              Code's ~/.claude/projects names, Codex session_meta cwds,
//              ATEM session repos) — never by scanning the whole disk.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { getHandlesRoot } = require('../handles.js');
const { PURPOSE_CANDIDATES } = require('../context.js');

const TASK_FILES = ['brief', 'state', 'next', 'decisions', 'validation', 'log', 'handoff'];

// Root-level entry docs that live outside docs/ but are clearly planning.
const SINGLE_FILES = [...new Set([
  ...PURPOSE_CANDIDATES,
  'PLAN.md',
  'AGENTS.md',
])];

// Always-planning holders, walked recursively regardless of project type.
const ALWAYS_TREES = [
  '.planning',
  'ADR',
  'adr',
];

// If docs/ is a published documentation SITE (Mintlify/MkDocs/Docusaurus),
// showing all of it would flood the viewer with the site (and its
// translations). Detect by config marker and fall back to planning-only.
const DOC_SITE_MARKERS = [
  'docs.json',          // Mintlify
  'mint.json',          // Mintlify (legacy)
  'mkdocs.yml',         // MkDocs
  'mkdocs.yaml',
  'docusaurus.config.js',
  'docusaurus.config.ts',
  'docusaurus.config.mjs',
];

// Planning-shaped subtrees inside a docs/ that is otherwise a doc-site.
const DOCS_PLANNING_SUBTREES = [
  'docs/superpowers',
  'docs/sub-plans',
  'docs/plans',
  'docs/specs',
  'docs/research',
  'docs/decisions',
  'docs/adr',
];

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Claude Code's ~/.claude/projects entries encode absolute paths with
// dashes standing in for '/' (and, in older encodings, '.'). Literal
// dashes in directory names are kept as-is, which makes decoding
// ambiguous. Instead of guessing per character (3^n blowup on
// undecodable names), match the remainder against the actual entries of
// each directory level: a dash in the encoded name may stand for the
// entry's '-', '.', or the component boundary. Undecodable → null.
function defaultListDir(p) {
  try { return fs.readdirSync(p); } catch { return null; }
}

function decodeClaudeProjectDir(encoded, listDir = defaultListDir) {
  if (!encoded.startsWith('-')) return null;

  // Does `rem` start with this entry name (under dash-substitution rules),
  // ending exactly or at a '-' boundary?
  function componentMatch(rem, name) {
    if (name.length > rem.length) return false;
    for (let i = 0; i < name.length; i++) {
      if (rem[i] === name[i]) continue;
      if (rem[i] === '-' && (name[i] === '.' || name[i] === '-')) continue;
      return false;
    }
    return rem.length === name.length || rem[name.length] === '-';
  }

  function walk(parent, rem) {
    if (rem === '') return parent;
    const entries = listDir(parent === '' ? '/' : parent);
    if (!entries) return null;
    for (const name of entries) {
      if (!componentMatch(rem, name)) continue;
      const rest = rem.slice(name.length); // '' or '-…'
      const r = walk(`${parent}/${name}`, rest.startsWith('-') ? rest.slice(1) : rest);
      if (r) return r;
    }
    return null;
  }

  return walk('', encoded.slice(1));
}

// Codex records the working directory in the session_meta first line of
// each rollout jsonl. Reading the first ~4KB of each file is enough.
function codexCwds(sessionsDir) {
  const cwds = [];
  if (!isDir(sessionsDir)) return cwds;
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.name.endsWith('.jsonl')) {
        try {
          const fd = fs.openSync(full, 'r');
          const buf = Buffer.alloc(4096);
          const n = fs.readSync(fd, buf, 0, 4096, 0);
          fs.closeSync(fd);
          const firstLine = buf.toString('utf8', 0, n).split('\n')[0];
          const meta = JSON.parse(firstLine);
          const cwd = meta && meta.payload && meta.payload.cwd;
          if (cwd) cwds.push(cwd);
        } catch { /* not a session file — skip */ }
      }
    }
  };
  walk(sessionsDir, 0);
  return cwds;
}

function listTaskIds(handlesDir) {
  if (!isDir(handlesDir)) return [];
  return fs.readdirSync(handlesDir, { withFileTypes: true })
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && e.name !== 'current')
    .filter((e) => !e.name.startsWith('_') && !e.name.startsWith('.'))
    .filter((e) => isDir(path.join(handlesDir, e.name)))
    .map((e) => e.name);
}

// The repo a hand-off task targets, read straight from its state.md
// (frontmatter or body). Covers target_repo / repo / cwd across the
// provider variants. Returns null when unknown.
function taskRepo(handlesDir, taskId) {
  try {
    const state = fs.readFileSync(path.join(handlesDir, taskId, 'state.md'), 'utf8');
    const m = state.match(/^\s*(?:target_repo|repo|cwd):\s*(.+?)\s*$/im);
    if (m) {
      const p = m[1].trim();
      if (p && p !== 'unknown') return p;
    }
  } catch { /* no state / unreadable */ }
  return null;
}

function atemTaskRepos(taskIds) {
  const repos = [];
  let session;
  try { session = require('../adapters/session.js'); } catch { return repos; }
  for (const id of taskIds) {
    try { repos.push(...session.listRepos(id)); } catch { /* task without state */ }
  }
  return repos;
}

function discoverRoots(opts = {}) {
  const claudeProjectsDir = opts.claudeProjectsDir
    || process.env.ATEM_WEB_CLAUDE_PROJECTS_DIR
    || path.join(os.homedir(), '.claude', 'projects');
  const codexSessionsDir = opts.codexSessionsDir
    || process.env.ATEM_WEB_CODEX_SESSIONS_DIR
    || path.join(os.homedir(), '.codex', 'sessions');

  const candidates = [];
  if (isDir(claudeProjectsDir)) {
    const cache = new Map();
    const cachedListDir = (p) => {
      if (!cache.has(p)) cache.set(p, defaultListDir(p));
      return cache.get(p);
    };
    for (const name of fs.readdirSync(claudeProjectsDir)) {
      const decoded = decodeClaudeProjectDir(name, cachedListDir);
      if (decoded) candidates.push(decoded);
    }
  }
  candidates.push(...codexCwds(codexSessionsDir));
  candidates.push(...atemTaskRepos(opts.taskIds || []));
  candidates.push(...(opts.extraRoots || []).filter(Boolean));

  const roots = [];
  const seen = new Set();
  for (const c of candidates) {
    if (/^\/(private\/)?tmp(\/|$)/.test(c)) continue;
    let real;
    try { real = fs.realpathSync(c); } catch { continue; }
    if (!isDir(real) || seen.has(real)) continue;
    seen.add(real);
    roots.push(real);
  }
  return roots;
}

// Resolve a discovered root to its parent repo. Worktrees should not show
// as separate top-level projects — they nest under the repo they belong
// to. Two signals: the Claude Code path convention (<repo>/.claude/
// worktrees/<name>), then git's common dir as a general fallback.
function resolveRepo(root, cache = new Map()) {
  const m = root.match(/^(.*)\/\.claude\/worktrees\/[^/]+$/);
  if (m && isDir(m[1])) return { repo: m[1], isWorktree: true };

  if (cache.has(root)) return cache.get(root);
  let result = { repo: root, isWorktree: false };
  try {
    const out = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) {
      const mainRepo = path.dirname(out); // .../<repo>/.git → .../<repo>
      let real = root;
      try { real = fs.realpathSync(root); } catch { /* keep */ }
      if (mainRepo && mainRepo !== real && isDir(mainRepo)) {
        result = { repo: mainRepo, isWorktree: true };
      }
    }
  } catch { /* not a git repo / git absent — treat as its own repo */ }
  cache.set(root, result);
  return result;
}

// Title + an optional status hint from a doc's head, in one read. The
// hint comes from a YAML `status:` field or a bold `**Status:**` line —
// the only reliable explicit signal; recency fills the rest.
function docMeta(absPath) {
  let title = path.basename(absPath);
  let statusHint = null;
  try {
    const head = fs.readFileSync(absPath, 'utf8').slice(0, 2048);
    const tm = head.match(/^#\s+(.+)$/m);
    if (tm) title = tm[1].trim();
    const sm = head.match(/^\s*\**status:?\**\s*(.+)$/im);
    if (sm) {
      const v = sm[1].toLowerCase();
      if (/(complete|done|executed|merged|shipped|archived|finished|closed)/.test(v)) statusHint = 'done';
      else if (/(active|in[ -]?progress|wip|current|ongoing)/.test(v)) statusHint = 'active';
    }
  } catch { /* fall through */ }
  return { title, statusHint };
}

function docTitle(absPath) { return docMeta(absPath).title; }

function statMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

// A docs/ is a published doc-site if a generator config sits in it or at
// the repo root.
function isDocSite(root, docsDir) {
  for (const marker of DOC_SITE_MARKERS) {
    if (fs.existsSync(path.join(docsDir, marker))) return true;
    if (fs.existsSync(path.join(root, marker))) return true;
  }
  return false;
}

// All planning docs of one project root: .planning/ + root ADR dirs +
// root entry files, plus docs/ — the whole docs/ holder for normal
// projects, or just its planning-shaped subtrees when docs/ is a
// published documentation site.
function scanProjectDocs(root) {
  const found = new Map(); // rel → {abs, rel, mtime, title, statusHint}
  const add = (abs) => {
    const rel = path.relative(root, abs);
    if (found.has(rel)) return;
    if (!fs.existsSync(abs)) return;
    const { title, statusHint } = docMeta(abs);
    found.set(rel, { abs, rel, mtime: statMtime(abs), title, statusHint });
  };

  const walkMd = (dir, depth) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walkMd(full, depth + 1);
      else if (e.name.endsWith('.md')) add(full);
    }
  };

  for (const tree of ALWAYS_TREES) walkMd(path.join(root, tree), 0);

  const docsDir = path.join(root, 'docs');
  if (isDir(docsDir)) {
    if (isDocSite(root, docsDir)) {
      for (const sub of DOCS_PLANNING_SUBTREES) walkMd(path.join(root, sub), 0);
    } else {
      walkMd(docsDir, 0);
    }
  }

  for (const rel of SINGLE_FILES) add(path.join(root, rel));

  return [...found.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}

// ── plan status classification ─────────────────────────────────────────
// The project's north-star doc (blue), the single newest plan/spec being
// worked on (green), and older plans (orange). Everything else uncolored.
const MAIN_BASENAMES = new Set(['action-plan.md', 'project.md', 'roadmap.md', 'plan.md', 'vision.md']);
const PLAN_DIR_RE = /(^|\/)(superpowers\/(plans|specs)|sub-plans|plans|specs|\.planning\/plans)(\/|$)/;

function isMainDoc(rel) {
  return MAIN_BASENAMES.has(path.basename(rel).toLowerCase());
}
function isPlanDoc(rel) {
  if (PLAN_DIR_RE.test(rel)) return true;
  return /(plan|spec|design|roadmap)/.test(path.basename(rel).toLowerCase());
}

// Mutates each record, adding a `status` of 'main' | 'active' | 'done' | null.
function classifyStatus(records) {
  const plans = records.filter((d) => !isMainDoc(d.rel) && isPlanDoc(d.rel));
  const auto = plans.filter((d) => !d.statusHint);
  const activeRel = auto.length
    ? auto.reduce((a, b) => (b.mtime > a.mtime ? b : a)).rel
    : null;
  for (const d of records) {
    if (isMainDoc(d.rel)) d.status = d.statusHint === 'done' ? 'done' : 'main';
    else if (isPlanDoc(d.rel)) d.status = d.statusHint || (d.rel === activeRel ? 'active' : 'done');
    else d.status = null;
  }
  return records;
}

// Claude Code keeps per-project memory (including plans it authored) under
// ~/.claude/projects/<encoded>/memory/. Map each repo realpath → its memory
// dir so those hidden files can be surfaced alongside the repo's docs.
function claudeMemoryByRoot(claudeProjectsDir) {
  const map = new Map();
  if (!isDir(claudeProjectsDir)) return map;
  const cache = new Map();
  const cachedListDir = (p) => {
    if (!cache.has(p)) cache.set(p, defaultListDir(p));
    return cache.get(p);
  };
  for (const name of fs.readdirSync(claudeProjectsDir)) {
    const decoded = decodeClaudeProjectDir(name, cachedListDir);
    if (!decoded) continue;
    const memDir = path.join(claudeProjectsDir, name, 'memory');
    if (!isDir(memDir)) continue;
    let real = decoded;
    try { real = fs.realpathSync(decoded); } catch { /* keep */ }
    map.set(real, memDir);
  }
  return map;
}

function memoryRecords(memDir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(memDir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const abs = path.join(memDir, name);
    const { title, statusHint } = docMeta(abs);
    out.push({ abs, rel: `‹claude memory›/${name}`, mtime: statMtime(abs), title, statusHint });
  }
  return out;
}

function buildTree(opts = {}) {
  const handlesDir = opts.handlesDir || getHandlesRoot();
  const docs = [];
  const newDoc = (meta) => {
    const id = docs.length;
    docs.push({ id, ...meta });
    return id;
  };

  // Hand-off tasks belong to the project they were run in, so they nest
  // under that project — there is no standalone Tasks group. Build a task
  // node per task (its 7 canonical files), tagged with the repo it targets.
  const realpath = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const taskIds = listTaskIds(handlesDir);
  const taskNodes = []; // { node, repo } — repo = realpath of the task's target, or null
  for (const taskId of taskIds) {
    const dir = path.join(handlesDir, taskId);
    const nodeKey = `task:${taskId}`;
    const ids = [];
    for (const f of TASK_FILES) {
      const abs = path.join(dir, `${f}.md`);
      if (!fs.existsSync(abs)) continue;
      ids.push(newDoc({
        path: abs, file: `${f}.md`, title: docTitle(abs),
        mtime: statMtime(abs), nodeKey, group: 'projects',
      }));
    }
    if (!ids.length) continue; // broken/empty task (e.g. dangling symlinks)
    const repoPath = taskRepo(handlesDir, taskId);
    const repoReal = repoPath && isDir(repoPath) ? realpath(repoPath) : null;
    const provider = taskId.includes(':') ? taskId.split(':')[0] : null;
    taskNodes.push({
      repo: repoReal,
      node: {
        key: nodeKey, label: taskId, provider, kind: 'task', docs: ids, children: [],
        mtime: Math.max(...ids.map((i) => docs[i].mtime)),
      },
    });
  }

  // Projects — worktrees nest under their repo; a repo's target tasks
  // (and any task targeting one of its worktrees) nest there too.
  const taskRepoPaths = taskNodes.map((t) => t.repo).filter(Boolean);
  const roots = discoverRoots({ ...opts, taskIds, extraRoots: [...(opts.extraRoots || []), ...taskRepoPaths] });
  const repoCache = new Map();

  // Group discovered roots by their parent repo.
  const repos = new Map(); // repoPath → { repo, worktrees:Set }
  const ensureRepo = (repoPath) => {
    if (!repos.has(repoPath)) repos.set(repoPath, { repo: repoPath, worktrees: new Set() });
    return repos.get(repoPath);
  };
  for (const root of roots) {
    const { repo, isWorktree } = resolveRepo(root, repoCache);
    const entry = ensureRepo(realpath(repo));
    if (isWorktree) entry.worktrees.add(root);
  }

  const claudeProjectsDir = opts.claudeProjectsDir
    || process.env.ATEM_WEB_CLAUDE_PROJECTS_DIR
    || path.join(os.homedir(), '.claude', 'projects');
  const memByRoot = claudeMemoryByRoot(claudeProjectsDir);

  const scanIntoNode = (root, kind) => {
    const records = scanProjectDocs(root);
    const memDir = memByRoot.get(realpath(root));
    if (memDir) records.push(...memoryRecords(memDir));
    classifyStatus(records);
    const nodeKey = kind === 'worktree' ? `worktree:${root}` : `project:${root}`;
    const ids = records.map((d) => newDoc({
      path: d.abs, file: d.rel, title: d.title, mtime: d.mtime, status: d.status, nodeKey, group: 'projects',
    }));
    return { key: nodeKey, label: path.basename(root), root, kind, docs: ids };
  };

  const projectNodes = [];
  const nodeByRoot = new Map(); // realpath → node (repo or worktree), for task attachment
  for (const { repo, worktrees } of repos.values()) {
    const repoNode = scanIntoNode(repo, 'repo');
    repoNode.children = [];
    nodeByRoot.set(realpath(repo), repoNode);
    for (const wt of [...worktrees].sort()) {
      const child = scanIntoNode(wt, 'worktree');
      if (child.docs.length) {
        child.children = child.children || [];
        repoNode.children.push(child);
        nodeByRoot.set(realpath(wt), child);
      }
    }
    projectNodes.push(repoNode);
  }

  // Attach each task to the node matching its target repo exactly (a
  // worktree if it targeted one), else the parent repo. Tasks with no
  // resolvable project are dropped — everything lives inside a project.
  for (const { node, repo } of taskNodes) {
    if (!repo) continue;
    let owner = nodeByRoot.get(repo);
    if (!owner) {
      const { repo: parent } = resolveRepo(repo, repoCache);
      owner = nodeByRoot.get(realpath(parent));
    }
    if (owner) owner.children.push(node);
  }

  // Drop empty nodes (no docs, no worktrees, no tasks) and sort.
  const kept = projectNodes.filter((n) => n.docs.length || n.children.length);
  for (const n of kept) {
    n.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'worktree' ? -1 : 1; // worktrees first, tasks after
      return a.label.localeCompare(b.label);
    });
  }
  kept.sort((a, b) => a.label.localeCompare(b.label));

  return {
    docs,
    groups: [{ kind: 'projects', nodes: kept }],
  };
}

module.exports = { buildTree, discoverRoots, decodeClaudeProjectDir, scanProjectDocs, codexCwds, TASK_FILES };
