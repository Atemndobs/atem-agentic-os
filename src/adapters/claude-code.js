// Claude Code provider adapter.
//
// Read-only on Claude's side. We never write to ~/.claude; we read:
//   - ~/.claude/sessions/<pid>.json — process registry (sessionId, cwd)
//   - ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl — transcript
//
// Contract documented in docs/research/claude-code-session-layout.md.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function getRootDir() {
  return process.env.ATEM_CLAUDE_CODE_DIR || path.join(os.homedir(), '.claude');
}

function getSessionsRegistryDir() {
  return path.join(getRootDir(), 'sessions');
}

function getProjectsDir() {
  return path.join(getRootDir(), 'projects');
}

// Lossy: each `/`, `\`, `:` becomes `-`. Leading `-` preserved. Matches
// the empirical naming under ~/.claude/projects/.
function encodeProjectDirName(cwd) {
  if (!cwd) return '';
  return cwd.replace(/[/\\:]/g, '-');
}

function readRegistry(pidFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function findTranscriptForRegistry(reg) {
  if (!reg) return null;
  if (!reg.sessionId) return null;
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return null;
  if (reg.cwd) {
    const guess = path.join(projectsDir, encodeProjectDirName(reg.cwd), `${reg.sessionId}.jsonl`);
    if (fs.existsSync(guess)) return guess;
  }
  // Fallback: scan all project dirs for a matching <sessionId>.jsonl.
  let dirs;
  try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return null; }
  for (const e of dirs) {
    if (!e.isDirectory()) continue;
    const candidate = path.join(projectsDir, e.name, `${reg.sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findSessionFileById(sessionId) {
  return findTranscriptForRegistry({ sessionId });
}

// Cheap read of the first entry that carries a `cwd` field. Many
// transcripts open with `queue-operation` entries that have no `cwd`,
// so we scan up to ~128 KiB of head bytes before giving up.
function sniffCwdFromTranscript(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(128 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.slice(0, n).toString('utf8');
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e && typeof e.cwd === 'string' && e.cwd) return e.cwd;
    }
  } catch { /* fall through */ }
  return '';
}

// Cheap read of the first user prompt — same head-scan as
// getClaudeSessions in cli.js. Returns "" if nothing found.
function sniffTitleFromTranscript(file, maxLen = 60) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(128 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.slice(0, n).toString('utf8');
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e && e.type === 'queue-operation' && e.operation === 'enqueue' && typeof e.content === 'string') {
        return e.content.replace(/\s+/g, ' ').trim().slice(0, maxLen);
      }
      const msg = e && e.message;
      if (msg && msg.role === 'user') {
        const text = typeof msg.content === 'string'
          ? msg.content
          : (Array.isArray(msg.content) && msg.content.find((b) => b && typeof b.text === 'string')?.text) || '';
        if (text) return String(text).replace(/\s+/g, ' ').trim().slice(0, maxLen);
      }
    }
  } catch { /* fall through */ }
  return '';
}

// Phase C.1: list transcripts touched within the given window. Cheap:
// stat all `.jsonl` files in projects/, drop anything older than the
// window, and only then sniff cwd + title from the survivors.
//
// Returns: [{ sessionId, cwd, title, file, mtimeMs }]
function listRecentSessions({ sinceMs, now = Date.now(), maxResults = 200 } = {}) {
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return [];
  const cutoff = typeof sinceMs === 'number'
    ? sinceMs
    : (now - require('../synthetic.js').getRecentWindowMs());
  let dirs;
  try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return []; }

  const candidates = [];
  for (const e of dirs) {
    if (!e.isDirectory()) continue;
    const subdir = path.join(projectsDir, e.name);
    let names;
    try { names = fs.readdirSync(subdir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(subdir, name);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (stat.mtimeMs < cutoff) continue;
      candidates.push({ file, mtimeMs: stat.mtimeMs, sessionId: name.slice(0, -'.jsonl'.length), encodedDir: e.name });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const trimmed = candidates.slice(0, maxResults);

  return trimmed.map((c) => ({
    sessionId: c.sessionId,
    cwd: sniffCwdFromTranscript(c.file),
    title: sniffTitleFromTranscript(c.file),
    file: c.file,
    mtimeMs: c.mtimeMs,
  }));
}

function findLatestSessionFile(cwd) {
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return null;
  const encoded = encodeProjectDirName(cwd);
  const target = path.join(projectsDir, encoded);
  if (!fs.existsSync(target)) return null;
  let names;
  try { names = fs.readdirSync(target); } catch { return null; }
  const jsonl = names
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => path.join(target, n));
  jsonl.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return jsonl[0] || null;
}

// ---- transcript scan ----------------------------------------------------

function firstTextBlock(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block) continue;
      if (typeof block.text === 'string') return block.text;
      if (typeof block.content === 'string') return block.content;
    }
  }
  return '';
}

function firstParagraph(text, maxLen = 600) {
  if (!text) return '';
  const trimmed = String(text).trim();
  if (!trimmed) return '';
  const para = trimmed.split(/\n\s*\n/)[0] || trimmed;
  return para.length > maxLen ? para.slice(0, maxLen) + '…' : para;
}

function truncate(text, maxLen) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

// Distill a transcript jsonl into the same shape the omp adapter
// produces. Skip sidechain entries (subagent turns) — they're not the
// canonical conversation state we want to hand off.
function distillSessionSync(sessionFile) {
  let raw;
  try { raw = fs.readFileSync(sessionFile, 'utf8'); } catch { return null; }
  const lines = raw.split('\n').filter(Boolean);

  let firstUserMessage = '';
  let lastUserMessage = '';
  let lastAssistantText = '';
  let lastModel = '';
  let currentMode = 'none';
  let cwd = '';
  let sessionId = '';
  let startedAt = '';
  // Track tool-call balance to detect "paused mid-tool".
  const openToolCalls = new Set();

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== 'object') continue;

    // Lightweight metadata entries.
    if (entry.type === 'mode' && typeof entry.mode === 'string') {
      currentMode = entry.mode;
      if (entry.sessionId && !sessionId) sessionId = entry.sessionId;
      continue;
    }
    if (entry.type === 'queue-operation') {
      if (entry.sessionId && !sessionId) sessionId = entry.sessionId;
      if (entry.timestamp && !startedAt) startedAt = entry.timestamp;
      continue;
    }

    // Message records. Skip sidechain (subagent) entries.
    const msg = entry.message;
    if (!msg || typeof msg !== 'object') continue;
    if (entry.isSidechain) continue;

    if (entry.cwd && !cwd) cwd = entry.cwd;
    if (entry.sessionId && !sessionId) sessionId = entry.sessionId;
    if (typeof msg.model === 'string') lastModel = msg.model;

    const role = msg.role;
    const text = firstTextBlock(msg.content);

    if (role === 'user' && text) {
      if (!firstUserMessage) firstUserMessage = text;
      lastUserMessage = text;
    } else if (role === 'assistant' && text) {
      lastAssistantText = text;
    }

    // Track tool_use / tool_result balance across user+assistant turns.
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_use' && block.id) {
          openToolCalls.add(block.id);
        } else if (block.type === 'tool_result' && block.tool_use_id) {
          openToolCalls.delete(block.tool_use_id);
        }
      }
    }
  }

  if (!sessionId) {
    // Last resort: sessionId from filename.
    sessionId = path.basename(sessionFile, '.jsonl');
  }

  return {
    sessionId,
    sessionFile,
    title: truncate(firstUserMessage, 60) || '',
    cwd,
    startedAt: startedAt || '',
    model: lastModel,
    mode: currentMode,
    firstTask: firstUserMessage,
    summary: firstParagraph(lastAssistantText),
    lastUserMessage,
    lastAssistantText,
    tools: [],
    pausedMidTool: openToolCalls.size > 0,
    labels: [],
  };
}

module.exports = {
  getRootDir,
  getSessionsRegistryDir,
  getProjectsDir,
  encodeProjectDirName,
  readRegistry,
  findTranscriptForRegistry,
  findSessionFileById,
  findLatestSessionFile,
  distillSessionSync,
  // Phase C.1
  listRecentSessions,
  sniffCwdFromTranscript,
  sniffTitleFromTranscript,
};
