// Symlink farm under ~/.atem/handles/ so providers whose tools can only
// read local file paths can still follow atem:// URLs by going through
// stable, predictable paths.
//
// Layout:
//   ~/.atem/handles/<task-id>/{brief,state,handoff,decisions,next,validation,log}.md
//   ~/.atem/handles/<task-id>/snapshots          (symlink to dir)
//   ~/.atem/handles/current                      (symlink to <task-id>)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ARTIFACT_ALIASES } = require('./url.js');

function getHandlesRoot() {
  return process.env.ATEM_HANDLES_DIR || path.join(os.homedir(), '.atem', 'handles');
}

function ensureSymlink(target, link) {
  // Remove anything at link path that isn't already the correct symlink.
  try {
    const current = fs.readlinkSync(link);
    if (current === target) return false;
    fs.unlinkSync(link);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // Not a symlink — could be a real file/dir left behind. Try to clear.
      try { fs.rmSync(link, { force: true, recursive: true }); } catch { /* ignore */ }
    }
  }
  fs.symlinkSync(target, link);
  return true;
}

function syncTaskHandles(paths, taskId) {
  const sessionDir = path.join(paths.harnessDir, 'sessions', taskId);
  if (!fs.existsSync(sessionDir)) return null;
  const root = getHandlesRoot();
  const taskHandleDir = path.join(root, taskId);
  fs.mkdirSync(taskHandleDir, { recursive: true });

  for (const [alias, fname] of Object.entries(ARTIFACT_ALIASES)) {
    const target = path.join(sessionDir, fname);
    const link = path.join(taskHandleDir, fname);
    if (fs.existsSync(target)) {
      try { ensureSymlink(target, link); } catch { /* best effort */ }
    } else {
      // Drop dangling links if the file disappeared.
      try { fs.unlinkSync(link); } catch { /* ignore */ }
    }
  }

  // Snapshots dir as a single symlink (if present).
  const snapsTarget = path.join(sessionDir, 'snapshots');
  const snapsLink = path.join(taskHandleDir, 'snapshots');
  if (fs.existsSync(snapsTarget)) {
    try { ensureSymlink(snapsTarget, snapsLink); } catch { /* best effort */ }
  }

  return taskHandleDir;
}

function syncCurrentPointer(paths) {
  // Resolve active task from current-session.md and point handles/current at it.
  let content = '';
  try { content = fs.readFileSync(paths.currentSessionFile, 'utf8'); } catch { return null; }
  const m = content.match(/^##\s*Active Task ID\s*\n+([^\n#][^\n]*)/m);
  const value = m ? m[1].trim() : '';
  if (!value || value === 'None') return null;
  const taskHandleDir = syncTaskHandles(paths, value);
  if (!taskHandleDir) return null;
  const root = getHandlesRoot();
  const currentLink = path.join(root, 'current');
  try { ensureSymlink(taskHandleDir, currentLink); } catch { /* best effort */ }
  return currentLink;
}

function syncAll(paths) {
  const root = path.join(paths.harnessDir, 'sessions');
  if (!fs.existsSync(root)) return [];
  const tasks = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  for (const taskId of tasks) syncTaskHandles(paths, taskId);
  syncCurrentPointer(paths);
  return tasks;
}

function listHandles() {
  const root = getHandlesRoot();
  if (!fs.existsSync(root)) return { root, tasks: [], current: null };
  const tasks = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'current')
    .map((e) => e.name);
  let current = null;
  try { current = fs.readlinkSync(path.join(root, 'current')); } catch { /* none */ }
  return { root, tasks, current };
}

function validate(paths) {
  // Used by doctor: returns { ok: bool, issues: string[] }.
  const issues = [];
  const root = getHandlesRoot();
  if (!fs.existsSync(root)) return { ok: true, issues };
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      try { fs.statSync(full); } catch { issues.push(`broken symlink: ${full}`); }
      continue;
    }
    if (entry.isDirectory()) {
      // Check that the task still exists in the harness.
      const sessionDir = path.join(paths.harnessDir, 'sessions', entry.name);
      if (!fs.existsSync(sessionDir)) {
        issues.push(`orphan handle dir for ${entry.name} (session removed)`);
        continue;
      }
      // Check each link in the dir.
      for (const f of fs.readdirSync(full, { withFileTypes: true })) {
        const link = path.join(full, f.name);
        try { fs.statSync(link); } catch { issues.push(`broken symlink: ${link}`); }
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

module.exports = {
  getHandlesRoot,
  syncTaskHandles,
  syncCurrentPointer,
  syncAll,
  listHandles,
  validate,
  ensureSymlink,
};
