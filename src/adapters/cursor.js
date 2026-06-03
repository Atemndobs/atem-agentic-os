// Cursor provider adapter.
//
// Read-only on Cursor's side. We never write to ~/Library/Application
// Support/Cursor; we read:
//   - workspaceStorage/<md5>/workspace.json    — folder URI per workspace
//   - workspaceStorage/<md5>/state.vscdb       — composer.composerData index
//   - globalStorage/state.vscdb                — bubble + composer payloads
//
// Contract documented in docs/research/cursor-session-layout.md.
//
// SQLite reads via the `sqlite3` CLI in `-json` mode. The codex
// launcher (D.7) already relies on `sqlite3` being on PATH; same
// soft dependency here.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// ---- path resolution -----------------------------------------------------

function getRootDir() {
  return (
    process.env.ATEM_CURSOR_DIR ||
    path.join(os.homedir(), 'Library', 'Application Support', 'Cursor')
  );
}

function getGlobalDbPath() {
  return path.join(getRootDir(), 'User', 'globalStorage', 'state.vscdb');
}

function getWorkspaceStorageRoot() {
  return path.join(getRootDir(), 'User', 'workspaceStorage');
}

function fileUriToPath(uri) {
  if (!uri || typeof uri !== 'string') return '';
  if (uri.startsWith('file://')) {
    return decodeURIComponent(uri.slice('file://'.length));
  }
  return uri;
}

// ---- sqlite helpers -------------------------------------------------------

// Run a query and return rows as parsed JSON objects. sqlite3 -json
// prints `[]` for empty result, which JSON.parse handles fine.
function querySqlite(dbPath, sql) {
  if (!fs.existsSync(dbPath)) return [];
  try {
    const out = execFileSync('sqlite3', ['-json', dbPath, sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024, // bubbles can be large
    });
    if (!out.trim()) return [];
    return JSON.parse(out);
  } catch {
    return [];
  }
}

// Read a single TEXT column from one row — the most common pattern.
function querySingleValue(dbPath, sql) {
  const rows = querySqlite(dbPath, sql);
  if (rows.length === 0) return null;
  const first = rows[0];
  const keys = Object.keys(first);
  return keys.length ? first[keys[0]] : null;
}

// SQL-quote: minimal escaping for the values we control (composer/bubble UUIDs).
function sqlQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// ---- workspace ↔ cwd ----------------------------------------------------

// Walk workspaceStorage; return [{ hash, dir, dbPath, folder, mtimeMs }]
// for every workspace whose workspace.json folder URI is the given cwd
// (or a path-within match).
function listWorkspacesForCwd(cwd) {
  const root = getWorkspaceStorageRoot();
  if (!fs.existsSync(root) || !cwd) return [];
  const target = path.resolve(cwd);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const matches = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const wsJson = path.join(dir, 'workspace.json');
    const dbPath = path.join(dir, 'state.vscdb');
    let folder;
    try {
      const raw = JSON.parse(fs.readFileSync(wsJson, 'utf8'));
      folder = fileUriToPath(raw.folder);
    } catch { continue; }
    if (!folder) continue;
    const resolved = path.resolve(folder);
    if (resolved !== target) continue;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(dbPath).mtimeMs; } catch { /* may not exist yet */ }
    matches.push({ hash: e.name, dir, dbPath, folder: resolved, mtimeMs });
  }
  return matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// List recently-touched workspaces (used by `atem status` to surface
// idle Cursor sessions in the recent window).
function listRecentWorkspaces({ sinceMs, now = Date.now() } = {}) {
  const root = getWorkspaceStorageRoot();
  if (!fs.existsSync(root)) return [];
  const cutoff = typeof sinceMs === 'number'
    ? sinceMs
    : (now - require('../synthetic.js').getRecentWindowMs());
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const matches = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const dbPath = path.join(dir, 'state.vscdb');
    const wsJson = path.join(dir, 'workspace.json');
    let stat;
    try { stat = fs.statSync(dbPath); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue;
    let folder = '';
    try {
      const raw = JSON.parse(fs.readFileSync(wsJson, 'utf8'));
      folder = fileUriToPath(raw.folder);
    } catch { /* keep going */ }
    matches.push({ hash: e.name, dir, dbPath, folder, mtimeMs: stat.mtimeMs });
  }
  return matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ---- composer index ------------------------------------------------------

function readWorkspaceComposers(workspaceDbPath) {
  const raw = querySingleValue(
    workspaceDbPath,
    "SELECT value FROM ItemTable WHERE key='composer.composerData'"
  );
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.allComposers)) return [];
    return parsed.allComposers.map((c) => ({
      composerId: c.composerId,
      createdAt: c.createdAt || 0,
      mode: c.unifiedMode || c.forceMode || '',
      archived: !!c.isArchived,
      draft: !!c.isDraft,
    }));
  } catch {
    return [];
  }
}

// Find composer IDs visible in a given cwd. Sorted newest createdAt first.
function listComposersForCwd(cwd) {
  const workspaces = listWorkspacesForCwd(cwd);
  const composers = [];
  for (const ws of workspaces) {
    const list = readWorkspaceComposers(ws.dbPath);
    for (const c of list) {
      if (c.archived) continue;
      composers.push({ ...c, workspaceHash: ws.hash, folder: ws.folder });
    }
  }
  composers.sort((a, b) => b.createdAt - a.createdAt);
  return composers;
}

function findLatestComposerForCwd(cwd) {
  const list = listComposersForCwd(cwd);
  return list[0] || null;
}

// ---- global content (bubbles + composer state) --------------------------

function readComposerData(composerId) {
  const dbPath = getGlobalDbPath();
  const raw = querySingleValue(
    dbPath,
    `SELECT value FROM cursorDiskKV WHERE key=${sqlQuote('composerData:' + composerId)}`
  );
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function readBubble(composerId, bubbleId) {
  const dbPath = getGlobalDbPath();
  const key = `bubbleId:${composerId}:${bubbleId}`;
  const raw = querySingleValue(
    dbPath,
    `SELECT value FROM cursorDiskKV WHERE key=${sqlQuote(key)}`
  );
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ---- distillation --------------------------------------------------------

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

// Distill a single Cursor composer. Returns the same shape every other
// distiller produces so the rest of ATEM treats Cursor identically.
function distillSessionSync(composerId, { cwd } = {}) {
  const composer = readComposerData(composerId);
  if (!composer) return null;

  const headers = Array.isArray(composer.fullConversationHeadersOnly)
    ? composer.fullConversationHeadersOnly
    : [];

  let firstUserMessage = '';
  let lastUserMessage = '';
  let lastAssistantText = '';
  const openToolCalls = new Set();

  for (const h of headers) {
    if (!h || !h.bubbleId) continue;
    const bubble = readBubble(composerId, h.bubbleId);
    if (!bubble) continue;
    const text = typeof bubble.text === 'string' ? bubble.text : '';
    const role = bubble.type === 1 ? 'user' : bubble.type === 2 ? 'assistant' : '';
    if (role === 'user' && text) {
      if (!firstUserMessage) firstUserMessage = text;
      lastUserMessage = text;
    } else if (role === 'assistant' && text) {
      lastAssistantText = text;
    }
    // Tool-call balance: Cursor encodes pending tools in suggestedCodeBlocks
    // and interpreterResults arrays. A blob with `result === null` or
    // pending status counts as in-flight. Best-effort.
    if (Array.isArray(bubble.toolResults)) {
      for (const t of bubble.toolResults) {
        if (!t) continue;
        if (t.toolCallId && (t.status === 'pending' || t.result === null || t.result === undefined)) {
          openToolCalls.add(t.toolCallId);
        } else if (t.toolCallId) {
          openToolCalls.delete(t.toolCallId);
        }
      }
    }
  }

  return {
    sessionId: composerId,
    sessionFile: getGlobalDbPath(),
    title: truncate(firstUserMessage, 60) || '',
    cwd: cwd || '',
    startedAt: composer.createdAt
      ? new Date(composer.createdAt).toISOString()
      : '',
    model: '', // Cursor doesn't expose per-turn model on bubbles
    mode: composer.unifiedMode || composer.forceMode || 'none',
    firstTask: firstUserMessage,
    summary: firstParagraph(lastAssistantText),
    lastUserMessage,
    lastAssistantText,
    tools: [],
    pausedMidTool: openToolCalls.size > 0,
    labels: [],
  };
}

// Convenience: distill the most-recent composer for a given cwd.
function distillLatestForCwd(cwd) {
  const c = findLatestComposerForCwd(cwd);
  if (!c) return null;
  return distillSessionSync(c.composerId, { cwd: c.folder });
}

// Find the global DB path for a composer id — used by adapter.findSessionFileById.
function findSessionFileById(composerId) {
  // Cursor stores all composers in the same global DB; if the id exists
  // we return that path. Otherwise null.
  const dbPath = getGlobalDbPath();
  const raw = querySingleValue(
    dbPath,
    `SELECT key FROM cursorDiskKV WHERE key=${sqlQuote('composerData:' + composerId)}`
  );
  return raw ? dbPath : null;
}

// Convenience for the adapter registry: latest session "file" for a cwd
// returns the global DB path when at least one composer matches.
function findLatestSessionFile(cwd) {
  return findLatestComposerForCwd(cwd) ? getGlobalDbPath() : null;
}

// Title sniff for the status table — cheap, no full distillation.
function sniffTitleFromComposer(composerId, maxLen = 60) {
  const composer = readComposerData(composerId);
  if (!composer) return '';
  const headers = composer.fullConversationHeadersOnly || [];
  for (const h of headers) {
    if (!h || h.type !== 1 || !h.bubbleId) continue; // user message
    const bubble = readBubble(composerId, h.bubbleId);
    if (bubble && bubble.text) {
      return truncate(bubble.text, maxLen);
    }
  }
  return '';
}

module.exports = {
  // Roots
  getRootDir,
  getGlobalDbPath,
  getWorkspaceStorageRoot,
  fileUriToPath,
  // Workspace discovery
  listWorkspacesForCwd,
  listRecentWorkspaces,
  readWorkspaceComposers,
  listComposersForCwd,
  findLatestComposerForCwd,
  // Content
  readComposerData,
  readBubble,
  // Distillation
  distillSessionSync,
  distillLatestForCwd,
  findSessionFileById,
  findLatestSessionFile,
  sniffTitleFromComposer,
};
