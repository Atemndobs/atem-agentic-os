// Tests for the Cursor adapter — G.1.2 of the universal-handoff plan.
//
// Builds a synthetic Cursor storage tree on disk (workspaceStorage +
// globalStorage state.vscdb files) and exercises the discovery +
// distillation paths against it. No real Cursor required.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const cursor = require('../src/adapters/cursor.js');

function mktmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

// Helpers for building Cursor's storage shape synthetically.
function makeCursorTree(root) {
  fs.mkdirSync(path.join(root, 'User', 'globalStorage'), { recursive: true });
  fs.mkdirSync(path.join(root, 'User', 'workspaceStorage'), { recursive: true });
}

function writeGlobalDb(root, rows) {
  // rows: [{ key, value }] for cursorDiskKV
  const dbPath = path.join(root, 'User', 'globalStorage', 'state.vscdb');
  execFileSync('sqlite3', [dbPath, `
    CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
  `], { stdio: 'ignore' });
  for (const row of rows) {
    const sql = `INSERT INTO cursorDiskKV (key, value) VALUES (${quote(row.key)}, ${quote(row.value)})`;
    execFileSync('sqlite3', [dbPath, sql], { stdio: 'ignore' });
  }
  return dbPath;
}

function addWorkspace(root, hash, folderPath, composerData) {
  const dir = path.join(root, 'User', 'workspaceStorage', hash);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'workspace.json'),
    JSON.stringify({ folder: 'file://' + folderPath })
  );
  const dbPath = path.join(dir, 'state.vscdb');
  execFileSync('sqlite3', [dbPath, `
    CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
  `], { stdio: 'ignore' });
  const sql = `INSERT INTO ItemTable (key, value) VALUES ('composer.composerData', ${quote(JSON.stringify(composerData))})`;
  execFileSync('sqlite3', [dbPath, sql], { stdio: 'ignore' });
  return dir;
}

function quote(s) { return `'${String(s).replace(/'/g, "''")}'`; }

function setCursorRoot(dir) { process.env.ATEM_CURSOR_DIR = dir; }
function clearCursorRoot() { delete process.env.ATEM_CURSOR_DIR; }

// --- workspace discovery -------------------------------------------------

test('G.1.2: listWorkspacesForCwd matches workspace.json folder URI', () => {
  const root = mktmp('atem-cursor-ws-');
  makeCursorTree(root);
  setCursorRoot(root);
  try {
    const cwd = '/Users/example/sites/demo';
    addWorkspace(root, 'aaaaaa', cwd, { allComposers: [] });
    addWorkspace(root, 'bbbbbb', '/Users/example/sites/other', { allComposers: [] });

    const matches = cursor.listWorkspacesForCwd(cwd);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].hash, 'aaaaaa');
    assert.equal(matches[0].folder, cwd);
  } finally { clearCursorRoot(); }
});

test('G.1.2: listWorkspacesForCwd returns [] for unknown cwd', () => {
  const root = mktmp('atem-cursor-empty-');
  makeCursorTree(root);
  setCursorRoot(root);
  try {
    const matches = cursor.listWorkspacesForCwd('/no/such/path');
    assert.deepEqual(matches, []);
  } finally { clearCursorRoot(); }
});

test('G.1.2: listComposersForCwd reads composer.composerData and sorts newest first', () => {
  const root = mktmp('atem-cursor-composers-');
  makeCursorTree(root);
  setCursorRoot(root);
  try {
    const cwd = '/Users/example/sites/demo';
    addWorkspace(root, 'h1', cwd, {
      allComposers: [
        { composerId: 'old-id',    createdAt: 1000, unifiedMode: 'agent', isArchived: false },
        { composerId: 'newest-id', createdAt: 9000, unifiedMode: 'edit',  isArchived: false },
        { composerId: 'archived',  createdAt: 5000, unifiedMode: 'ask',   isArchived: true  },
      ],
    });
    const list = cursor.listComposersForCwd(cwd);
    assert.equal(list.length, 2, 'archived should be filtered');
    assert.equal(list[0].composerId, 'newest-id', 'newest first');
    assert.equal(list[1].composerId, 'old-id');
  } finally { clearCursorRoot(); }
});

// --- distillation --------------------------------------------------------

test('G.1.2: distillSessionSync produces the canonical adapter shape', () => {
  const root = mktmp('atem-cursor-distill-');
  makeCursorTree(root);
  setCursorRoot(root);
  try {
    const composerId = 'demo-composer';
    const bubbles = [
      { bubbleId: 'u1', type: 1, text: 'investigate the cache eviction policy' },
      { bubbleId: 'a1', type: 2, text: 'I see the policy is LRU. Verifying with a test.' },
      { bubbleId: 'u2', type: 1, text: 'good, please continue' },
      { bubbleId: 'a2', type: 2, text: 'Final summary: cache is LRU with a 5 minute TTL.' },
    ];
    const composerData = {
      _v: 9,
      composerId,
      createdAt: 1_700_000_000_000,
      unifiedMode: 'agent',
      fullConversationHeadersOnly: bubbles.map((b) => ({ bubbleId: b.bubbleId, type: b.type })),
    };
    const rows = [
      { key: `composerData:${composerId}`, value: JSON.stringify(composerData) },
      ...bubbles.map((b) => ({
        key: `bubbleId:${composerId}:${b.bubbleId}`,
        value: JSON.stringify({ _v: 3, ...b }),
      })),
    ];
    writeGlobalDb(root, rows);

    const d = cursor.distillSessionSync(composerId, { cwd: '/x/y' });
    assert.equal(d.sessionId, composerId);
    assert.equal(d.cwd, '/x/y');
    assert.equal(d.mode, 'agent');
    assert.match(d.title, /investigate the cache eviction/);
    assert.match(d.firstTask, /investigate the cache eviction policy/);
    assert.match(d.lastAssistantText, /Final summary: cache is LRU/);
    assert.match(d.summary, /Final summary/);
    assert.equal(d.pausedMidTool, false);
  } finally { clearCursorRoot(); }
});

test('G.1.2: pausedMidTool fires when toolResults has a pending entry', () => {
  const root = mktmp('atem-cursor-pending-');
  makeCursorTree(root);
  setCursorRoot(root);
  try {
    const composerId = 'paused-composer';
    const composerData = {
      _v: 9,
      composerId,
      createdAt: 1_700_000_000_000,
      unifiedMode: 'agent',
      fullConversationHeadersOnly: [
        { bubbleId: 'u1', type: 1 },
        { bubbleId: 'a1', type: 2 },
      ],
    };
    const rows = [
      { key: `composerData:${composerId}`, value: JSON.stringify(composerData) },
      { key: `bubbleId:${composerId}:u1`,  value: JSON.stringify({ _v: 3, type: 1, text: 'run the tests' }) },
      { key: `bubbleId:${composerId}:a1`,  value: JSON.stringify({
        _v: 3, type: 2, text: 'running tests now',
        toolResults: [{ toolCallId: 'tc-1', status: 'pending', result: null }],
      }) },
    ];
    writeGlobalDb(root, rows);
    const d = cursor.distillSessionSync(composerId, { cwd: '/x' });
    assert.equal(d.pausedMidTool, true);
  } finally { clearCursorRoot(); }
});

test('G.1.2: distillLatestForCwd picks the newest non-archived composer', () => {
  const root = mktmp('atem-cursor-latest-');
  makeCursorTree(root);
  setCursorRoot(root);
  try {
    const cwd = '/repo/here';
    addWorkspace(root, 'h1', cwd, {
      allComposers: [
        { composerId: 'old', createdAt: 1000, unifiedMode: 'edit',  isArchived: false },
        { composerId: 'new', createdAt: 9000, unifiedMode: 'agent', isArchived: false },
      ],
    });
    writeGlobalDb(root, [
      { key: 'composerData:new', value: JSON.stringify({
        _v: 9, composerId: 'new', createdAt: 9000, unifiedMode: 'agent',
        fullConversationHeadersOnly: [{ bubbleId: 'u', type: 1 }],
      }) },
      { key: 'bubbleId:new:u', value: JSON.stringify({ _v: 3, type: 1, text: 'newest task' }) },
    ]);
    const d = cursor.distillLatestForCwd(cwd);
    assert.ok(d);
    assert.equal(d.sessionId, 'new');
    assert.match(d.firstTask, /newest task/);
  } finally { clearCursorRoot(); }
});

// --- sniff helpers + URL plumbing ---------------------------------------

test('G.1.2: sniffTitleFromComposer returns first user bubble text', () => {
  const root = mktmp('atem-cursor-sniff-');
  makeCursorTree(root);
  setCursorRoot(root);
  try {
    const composerId = 'sniff';
    writeGlobalDb(root, [
      { key: `composerData:${composerId}`, value: JSON.stringify({
        _v: 9, composerId, createdAt: 1,
        fullConversationHeadersOnly: [
          { bubbleId: 'a1', type: 2 },                // assistant first - skip
          { bubbleId: 'u1', type: 1 },                // first user
          { bubbleId: 'u2', type: 1 },
        ],
      }) },
      { key: `bubbleId:${composerId}:a1`, value: JSON.stringify({ type: 2, text: 'system message' }) },
      { key: `bubbleId:${composerId}:u1`, value: JSON.stringify({ type: 1, text: 'fix the build please' }) },
      { key: `bubbleId:${composerId}:u2`, value: JSON.stringify({ type: 1, text: 'second' }) },
    ]);
    const title = cursor.sniffTitleFromComposer(composerId);
    assert.match(title, /fix the build please/);
  } finally { clearCursorRoot(); }
});

test('G.1.2: fileUriToPath decodes URL-encoded paths', () => {
  assert.equal(cursor.fileUriToPath('file:///Users/example/has%20space'), '/Users/example/has space');
  assert.equal(cursor.fileUriToPath('/literal/path'), '/literal/path');
  assert.equal(cursor.fileUriToPath(''), '');
});

test('G.1.2: findSessionFileById returns the global DB path when composer exists', () => {
  const root = mktmp('atem-cursor-find-');
  makeCursorTree(root);
  setCursorRoot(root);
  try {
    writeGlobalDb(root, [
      { key: 'composerData:known', value: '{}' },
    ]);
    const known = cursor.findSessionFileById('known');
    assert.ok(known);
    assert.match(known, /globalStorage\/state\.vscdb$/);
    const unknown = cursor.findSessionFileById('does-not-exist');
    assert.equal(unknown, null);
  } finally { clearCursorRoot(); }
});
