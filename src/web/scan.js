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

const { getHandlesRoot } = require('../handles.js');
const { PURPOSE_CANDIDATES, RESEARCH_DIRS, DECISION_DIRS } = require('../context.js');

const TASK_FILES = ['brief', 'state', 'next', 'decisions', 'validation', 'log', 'handoff'];

const SINGLE_FILES = [...new Set([
  ...PURPOSE_CANDIDATES,
  'PLAN.md',
  'AGENTS.md',
])];

const SCAN_DIRS = [...new Set([
  'docs/sub-plans',
  ...RESEARCH_DIRS,
  ...DECISION_DIRS,
])];

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Claude Code's ~/.claude/projects entries encode absolute paths with
// dashes standing in for '/' (and, in older encodings, '.'). Literal
// dashes in directory names are kept as-is, which makes decoding
// ambiguous — so we DFS over the three readings of each dash and prune
// with filesystem existence checks. Undecodable names return null.
function decodeClaudeProjectDir(encoded, exists = fs.existsSync) {
  if (!encoded.startsWith('-')) return null;
  const s = encoded.slice(1);

  function dfs(i, parent, pending) {
    if (i === s.length) {
      if (!pending) return null;
      const full = `${parent}/${pending}`;
      return exists(full) ? full : null;
    }
    const ch = s[i];
    if (ch !== '-') return dfs(i + 1, parent, pending + ch);
    // dash: try '/' (component boundary), literal '-', then '.' (old encoding)
    if (pending) {
      const full = `${parent}/${pending}`;
      if (exists(full)) {
        const r = dfs(i + 1, full, '');
        if (r) return r;
      }
    }
    const literal = dfs(i + 1, parent, pending + '-');
    if (literal) return literal;
    return dfs(i + 1, parent, pending + '.');
  }

  return dfs(0, '', '');
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
    for (const name of fs.readdirSync(claudeProjectsDir)) {
      const decoded = decodeClaudeProjectDir(name);
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

function docTitle(absPath) {
  try {
    const head = fs.readFileSync(absPath, 'utf8').slice(0, 2048);
    const m = head.match(/^#\s+(.+)$/m);
    if (m) return m[1].trim();
  } catch { /* fall through */ }
  return path.basename(absPath);
}

function statMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

// All planning docs of one project root: .planning/** plus the
// authoritative single files and category dirs from the spec.
function scanProjectDocs(root) {
  const found = new Map(); // rel → {abs, rel, file, mtime, title}
  const add = (abs) => {
    const rel = path.relative(root, abs);
    if (found.has(rel)) return;
    if (!fs.existsSync(abs)) return;
    found.set(rel, { abs, rel, file: path.basename(abs), mtime: statMtime(abs), title: docTitle(abs) });
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

  walkMd(path.join(root, '.planning'), 0);
  for (const dir of SCAN_DIRS) {
    const full = path.join(root, dir);
    if (!isDir(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (name.endsWith('.md')) add(path.join(full, name));
    }
  }
  for (const rel of SINGLE_FILES) add(path.join(root, rel));

  return [...found.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}

function buildTree(opts = {}) {
  const handlesDir = opts.handlesDir || getHandlesRoot();
  const docs = [];
  const newDoc = (meta) => {
    const id = docs.length;
    docs.push({ id, ...meta });
    return id;
  };

  // Tasks group
  const taskIds = listTaskIds(handlesDir);
  const taskNodes = [];
  for (const taskId of taskIds) {
    const dir = path.join(handlesDir, taskId);
    const nodeKey = `task:${taskId}`;
    const ids = [];
    for (const f of TASK_FILES) {
      const abs = path.join(dir, `${f}.md`);
      if (!fs.existsSync(abs)) continue;
      ids.push(newDoc({
        path: abs, file: `${f}.md`, title: docTitle(abs),
        mtime: statMtime(abs), nodeKey, group: 'tasks',
      }));
    }
    if (!ids.length) continue;
    const provider = taskId.includes(':') ? taskId.split(':')[0] : null;
    taskNodes.push({
      key: nodeKey, label: taskId, provider, docs: ids,
      mtime: Math.max(...ids.map((i) => docs[i].mtime)),
    });
  }
  taskNodes.sort((a, b) => b.mtime - a.mtime);

  // Projects group
  const roots = discoverRoots({ ...opts, taskIds });
  const projectNodes = [];
  for (const root of roots) {
    const projectDocs = scanProjectDocs(root);
    if (!projectDocs.length) continue;
    const nodeKey = `project:${root}`;
    const ids = projectDocs.map((d) => newDoc({
      path: d.abs, file: d.rel, title: d.title, mtime: d.mtime, nodeKey, group: 'projects',
    }));
    projectNodes.push({ key: nodeKey, label: path.basename(root), root, docs: ids });
  }
  projectNodes.sort((a, b) => a.label.localeCompare(b.label));

  return {
    docs,
    groups: [
      { kind: 'tasks', nodes: taskNodes },
      { kind: 'projects', nodes: projectNodes },
    ],
  };
}

module.exports = { buildTree, discoverRoots, decodeClaudeProjectDir, scanProjectDocs, codexCwds, TASK_FILES };
