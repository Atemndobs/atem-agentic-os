// atem:// URL resolver. See docs/url-scheme.md for the spec.
//
// Pure module: given a URL string and a paths bundle (from
// resolveActivePaths), return what the URL points to as a structured
// result. No side effects, no symlink creation — those live in
// src/handles.js so the resolver stays trivially testable.

const fs = require('node:fs');
const path = require('node:path');

const synthetic = require('./synthetic.js');
const aliases = require('./aliases.js');

const ARTIFACT_ALIASES = {
  brief: 'brief.md',
  state: 'state.md',
  handoff: 'handoff.md',
  decisions: 'decisions.md',
  next: 'next.md',
  validation: 'validation.md',
  log: 'log.md',
};

function err(code, message) {
  return { kind: 'error', code, message };
}

function file(localPath, mimeType = 'text/markdown', metadata = {}) {
  return { kind: 'file', localPath, mimeType, metadata };
}

function directory(localPath, metadata = {}) {
  return { kind: 'directory', localPath, metadata };
}

function virtual(payload, mimeType = 'application/json') {
  return { kind: 'virtual', payload, mimeType };
}

function isSafeRelative(rel) {
  if (!rel) return false;
  if (rel.includes('\0')) return false;
  const normalized = path.posix.normalize(rel);
  if (normalized.startsWith('../') || normalized === '..' || normalized.includes('/../')) {
    return false;
  }
  if (path.isAbsolute(normalized)) return false;
  return true;
}

function parseUrl(url) {
  if (typeof url !== 'string') return null;
  if (!url.startsWith('atem://')) return null;
  const rest = url.slice('atem://'.length);
  const [pathPart, queryPart] = rest.split('?', 2);
  const segments = pathPart.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const target = segments[0];
  const tail = segments.slice(1);
  const query = {};
  if (queryPart) {
    for (const pair of queryPart.split('&')) {
      const [k, v = 'true'] = pair.split('=', 2);
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v);
    }
  }
  return { target, tail, query };
}

// Read the currently-active task id from current-session.md.
// We do the minimum parse to avoid importing the whole cli.js graph.
function getActiveTaskId(paths) {
  try {
    const content = fs.readFileSync(paths.currentSessionFile, 'utf8');
    const m = content.match(/^##\s*Active Task ID\s*\n+([^\n#][^\n]*)/m);
    if (!m) return null;
    const value = m[1].trim();
    if (!value || value === 'None') return null;
    return value;
  } catch {
    return null;
  }
}

function listSessions(paths) {
  const root = path.join(paths.harnessDir, 'sessions');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function resolveArtifact(sessionDir, tail) {
  if (tail.length === 0) {
    return directory(sessionDir, { artifact: 'session-root' });
  }
  const [head, ...rest] = tail;

  if (head === 'snapshots') {
    const snapsRoot = path.join(sessionDir, 'snapshots');
    if (rest.length === 0) {
      return fs.existsSync(snapsRoot)
        ? directory(snapsRoot, { artifact: 'snapshots' })
        : err('missing-file', `snapshots directory missing at ${snapsRoot}`);
    }
    const [snapId, ...inner] = rest;
    if (!isSafeRelative(snapId)) return err('path-traversal', `unsafe snapshot id: ${snapId}`);
    const snapDir = path.join(snapsRoot, snapId);
    if (inner.length === 0) {
      return fs.existsSync(snapDir)
        ? directory(snapDir, { artifact: 'snapshot', snapshotId: snapId })
        : err('missing-file', `snapshot ${snapId} not found`);
    }
    const innerRel = inner.join('/');
    if (!isSafeRelative(innerRel)) return err('path-traversal', `unsafe snapshot file: ${innerRel}`);
    const innerPath = path.join(snapDir, innerRel);
    return fs.existsSync(innerPath)
      ? file(innerPath, 'application/octet-stream', { artifact: 'snapshot-file', snapshotId: snapId })
      : err('missing-file', `snapshot file ${innerRel} not in ${snapDir}`);
  }

  if (head === 'files') {
    if (rest.length === 0) return err('unknown-artifact', 'files requires a path');
    const rel = rest.join('/');
    if (!isSafeRelative(rel)) return err('path-traversal', `unsafe file path: ${rel}`);
    const full = path.join(sessionDir, rel);
    return fs.existsSync(full)
      ? file(full, 'application/octet-stream', { artifact: 'session-file', rel })
      : err('missing-file', `no file at ${full}`);
  }

  // Single-segment artifact alias.
  if (rest.length !== 0) {
    return err('unknown-artifact', `artifact "${head}" does not accept sub-paths`);
  }
  const fname = ARTIFACT_ALIASES[head];
  if (!fname) return err('unknown-artifact', `unknown artifact: ${head}`);
  const full = path.join(sessionDir, fname);
  return fs.existsSync(full)
    ? file(full, 'text/markdown', { artifact: head })
    : err('missing-file', `no ${fname} at ${full}`);
}

// Synthetic resolution: when the target is a `<provider>:<id>` synthetic
// task that has not been materialized, route to the provider adapter's
// `resolveSynthetic(syntheticId, artifact)` for a virtual payload.
// Materialization happens in Phase B; here we stay read-only.
function resolveSyntheticVirtual(syntheticId, tail) {
  // Lazy-require the adapters registry to avoid load-order cycles.
  let registry;
  try { registry = require('./adapters/index.js'); }
  catch { return err('unknown-task', `synthetic resolve failed: no adapters`); }
  const parsed = synthetic.parseSyntheticId(syntheticId);
  if (!parsed) return err('unknown-task', `not a known synthetic id: ${syntheticId}`);
  const adapter = registry.adapters[parsed.provider];
  if (!adapter || typeof adapter.resolveSynthetic !== 'function') {
    return err('unknown-task', `provider ${parsed.provider} has no resolveSynthetic`);
  }
  const artifact = tail.length === 0 ? 'overview' : tail.join('/');
  try {
    const result = adapter.resolveSynthetic(syntheticId, artifact);
    if (!result || typeof result.content !== 'string') {
      return err('missing-file', `synthetic ${syntheticId}/${artifact}: empty result`);
    }
    return virtual(result.content, result.mimeType || 'text/markdown');
  } catch (e) {
    return err('missing-file', `synthetic resolve threw: ${e.message}`);
  }
}

// Public API. paths = result of resolveActivePaths(gitRoot).
function resolve(url, paths) {
  if (!paths || !paths.harnessDir) return err('harness-not-initialized', 'no harness paths');
  const parsed = parseUrl(url);
  if (!parsed) return err('unknown-artifact', `not an atem:// URL: ${url}`);

  if (parsed.target === 'list') {
    return virtual({ sessions: listSessions(paths) }, 'application/json');
  }

  let taskId;
  if (parsed.target === 'current') {
    taskId = getActiveTaskId(paths);
    if (!taskId) return err('no-active-session', 'no active task in current-session.md');
  } else {
    taskId = parsed.target;
  }

  // Alias dereference (Phase B). The alias table maps human-friendly
  // names to either a synthetic id or a TASK-N id. We do at most one
  // hop to avoid alias-of-alias cycles.
  const aliasTarget = aliases.resolveAlias(paths, taskId);
  if (aliasTarget) taskId = aliasTarget;

  // Synthetic task ids (`<provider>:<id>`) take precedence over the path
  // safety check below — colons are allowed in this form.
  if (synthetic.isSyntheticId(taskId)) {
    const sessionDir = path.join(paths.harnessDir, 'sessions', taskId);
    if (fs.existsSync(sessionDir)) {
      // Already materialized — same code path as any other task.
      return resolveArtifact(sessionDir, parsed.tail);
    }
    // Unmaterialized: route to provider adapter for a virtual payload.
    return resolveSyntheticVirtual(taskId, parsed.tail);
  }

  // Reject obviously bogus task ids (path traversal, separators).
  if (!isSafeRelative(taskId)) {
    return err('path-traversal', `unsafe task id: ${taskId}`);
  }

  const sessionDir = path.join(paths.harnessDir, 'sessions', taskId);
  if (!fs.existsSync(sessionDir)) {
    return err('unknown-task', `no session directory at ${sessionDir}`);
  }
  return resolveArtifact(sessionDir, parsed.tail);
}

module.exports = {
  resolve,
  parseUrl,
  ARTIFACT_ALIASES,
  // Exposed for tests and handles.js
  getActiveTaskId,
  listSessions,
};
