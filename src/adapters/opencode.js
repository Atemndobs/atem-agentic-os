// OpenCode provider adapter.
//
// Read-only. Reads a single SQLite database at
// `~/.local/share/opencode/opencode.db` containing session, message, and
// part tables. Schema documented in
// `docs/research/opencode-session-layout.md`.
//
// SQLite reads via the `sqlite3` CLI in `-json` mode, same approach as
// the Cursor and Codex SQLite-write paths.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { whichSync } = require('../which.js');

// ---- path resolution ----------------------------------------------------

function getDbPath() {
  if (process.env.ATEM_OPENCODE_DB) return process.env.ATEM_OPENCODE_DB;
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

function whichOpencode() {
  if (process.env.ATEM_OPENCODE_BIN) return process.env.ATEM_OPENCODE_BIN;
  return whichSync('opencode');
}

// ---- sqlite helpers -----------------------------------------------------

function querySqlite(sql, dbPath = getDbPath()) {
  if (!fs.existsSync(dbPath)) return [];
  try {
    const out = execFileSync('sqlite3', ['-json', dbPath, sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (!out.trim()) return [];
    return JSON.parse(out);
  } catch {
    return [];
  }
}

function sqlQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// ---- discovery ----------------------------------------------------------

function listSessionsForCwd(cwd, { includeArchived = false } = {}) {
  if (!cwd) return [];
  const target = path.resolve(cwd);
  // directory may have a trailing slash or differ in case; do a tight
  // equality match first, then a path-prefix fallback for monorepo subdirs.
  let rows = querySqlite(`
    SELECT id, title, directory, time_created, time_updated, time_archived
      FROM session
     WHERE directory = ${sqlQuote(target)}
       ${includeArchived ? '' : 'AND time_archived IS NULL'}
     ORDER BY time_updated DESC
  `);
  if (rows.length === 0) {
    rows = querySqlite(`
      SELECT id, title, directory, time_created, time_updated, time_archived
        FROM session s
        JOIN project p ON p.id = s.project_id
       WHERE p.worktree = ${sqlQuote(target)}
         ${includeArchived ? '' : 'AND time_archived IS NULL'}
       ORDER BY time_updated DESC
    `);
  }
  return rows;
}

function findLatestSessionForCwd(cwd) {
  const list = listSessionsForCwd(cwd);
  return list[0] || null;
}

// Listing for `atem status` (idle + live in the recent window).
function listRecentSessions({ sinceMs, now = Date.now() } = {}) {
  const cutoff = typeof sinceMs === 'number'
    ? sinceMs
    : (now - require('../synthetic.js').getRecentWindowMs());
  return querySqlite(`
    SELECT id, title, directory, time_created, time_updated
      FROM session
     WHERE time_updated >= ${Math.floor(cutoff)}
       AND time_archived IS NULL
     ORDER BY time_updated DESC
     LIMIT 50
  `);
}

function readSessionRow(sessionId) {
  const rows = querySqlite(
    `SELECT * FROM session WHERE id = ${sqlQuote(sessionId)} LIMIT 1`
  );
  return rows[0] || null;
}

function findSessionFileById(sessionId) {
  const row = readSessionRow(sessionId);
  return row ? getDbPath() : null;
}

function findLatestSessionFile(cwd) {
  return findLatestSessionForCwd(cwd) ? getDbPath() : null;
}

// ---- message + part traversal -------------------------------------------

function readMessages(sessionId) {
  return querySqlite(`
    SELECT id, data, time_created
      FROM message
     WHERE session_id = ${sqlQuote(sessionId)}
     ORDER BY time_created ASC
  `);
}

function readPartsForMessage(messageId) {
  return querySqlite(`
    SELECT data, time_created
      FROM part
     WHERE message_id = ${sqlQuote(messageId)}
     ORDER BY time_created ASC
  `);
}

function safeJSON(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// Combine all text-part data for a message into one string. Tool-parts
// contribute their output text when present (assistant turns) or nothing
// (user turns send tool_result style separately).
function collectMessageText(message) {
  const parts = readPartsForMessage(message.id);
  const text = [];
  let pausedMidTool = false;
  for (const p of parts) {
    const data = safeJSON(p.data);
    if (!data) continue;
    if (data.type === 'text' && typeof data.text === 'string') {
      text.push(data.text);
    } else if (data.type === 'tool') {
      const status = data.state && data.state.status;
      if (status && status !== 'completed' && status !== 'aborted') {
        pausedMidTool = true;
      }
    }
  }
  return { text: text.join('\n').trim(), pausedMidTool };
}

// ---- distillation -------------------------------------------------------

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

function distillSessionSync(sessionId, { cwd } = {}) {
  const sessionRow = readSessionRow(sessionId);
  if (!sessionRow) return null;
  const messages = readMessages(sessionId);

  let firstUserMessage = '';
  let lastUserMessage = '';
  let lastAssistantText = '';
  let lastModel = '';
  let lastMode = '';
  let pausedMidTool = false;

  for (const m of messages) {
    const meta = safeJSON(m.data) || {};
    const { text, pausedMidTool: paused } = collectMessageText(m);
    if (paused) pausedMidTool = true;
    if (meta.model && meta.model.modelID) lastModel = meta.model.modelID;
    if (meta.mode) lastMode = meta.mode;
    else if (meta.agent) lastMode = meta.agent;
    if (!text) continue;
    if (meta.role === 'user') {
      if (!firstUserMessage) firstUserMessage = text;
      lastUserMessage = text;
    } else if (meta.role === 'assistant') {
      lastAssistantText = text;
    }
  }

  return {
    sessionId,
    sessionFile: getDbPath(),
    title: sessionRow.title || truncate(firstUserMessage, 60) || '',
    cwd: cwd || sessionRow.directory || '',
    startedAt: sessionRow.time_created
      ? new Date(sessionRow.time_created).toISOString()
      : '',
    model: lastModel,
    mode: lastMode || 'none',
    firstTask: firstUserMessage,
    summary: firstParagraph(lastAssistantText),
    lastUserMessage,
    lastAssistantText,
    tools: [],
    pausedMidTool,
    labels: [],
  };
}

function distillLatestForCwd(cwd) {
  const latest = findLatestSessionForCwd(cwd);
  if (!latest) return null;
  return distillSessionSync(latest.id, { cwd: latest.directory });
}

function sniffTitleFromSession(sessionId, maxLen = 60) {
  const row = readSessionRow(sessionId);
  if (!row) return '';
  return truncate(row.title, maxLen);
}

module.exports = {
  // Paths
  getDbPath,
  whichOpencode,
  // Discovery
  listSessionsForCwd,
  findLatestSessionForCwd,
  listRecentSessions,
  readSessionRow,
  findSessionFileById,
  findLatestSessionFile,
  // Content
  readMessages,
  readPartsForMessage,
  // Distillation
  distillSessionSync,
  distillLatestForCwd,
  sniffTitleFromSession,
};
