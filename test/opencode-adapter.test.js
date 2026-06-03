// G.2 — OpenCode distiller + launcher tests.
//
// Builds a synthetic opencode.db with the real schema and exercises
// the discovery + distillation paths. Launcher uses dependency-
// injected spawnFn so it doesn't actually launch opencode in CI.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');

const opencodeAdapter = require('../src/adapters/opencode.js');
const opencodeLauncher = require('../src/launchers/opencode.js');

function mktmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function quote(s) { return `'${String(s).replace(/'/g, "''")}'`; }

function makeFakeOpencodeDb(dir) {
  const dbPath = path.join(dir, 'opencode.db');
  const schema = `
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER,
      workspace_id TEXT
    );
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      vcs TEXT,
      name TEXT,
      icon_url TEXT,
      icon_color TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_initialized INTEGER,
      sandboxes TEXT NOT NULL,
      commands TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `;
  execFileSync('sqlite3', [dbPath, schema], { stdio: 'ignore' });
  return dbPath;
}

function seedSession(dbPath, { id, directory, title, projectId = 'proj-1', archived = null, model = 'big-pickle', mode = 'build', messages = [] }) {
  const now = Date.now();
  const sql = [
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (${quote(id)}, ${quote(projectId)}, ${quote(id)}, ${quote(directory)}, ${quote(title)}, '1.0', ${now}, ${now}, ${archived === null ? 'NULL' : archived});`,
  ];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    const msgId = `${id}-m${i}`;
    const msgData = JSON.stringify({
      role: m.role,
      agent: 'build',
      model: { providerID: 'opencode', modelID: model },
      mode,
      time: { created: now + i, completed: now + i + 100 },
    });
    sql.push(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${quote(msgId)}, ${quote(id)}, ${now + i}, ${now + i}, ${quote(msgData)});`);
    for (let j = 0; j < (m.parts || []).length; j += 1) {
      const p = m.parts[j];
      const pid = `${msgId}-p${j}`;
      sql.push(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (${quote(pid)}, ${quote(msgId)}, ${quote(id)}, ${now + i}, ${now + i}, ${quote(JSON.stringify(p))});`);
    }
  }
  execFileSync('sqlite3', [dbPath, sql.join('\n')], { stdio: 'ignore' });
}

// --- adapter tests --------------------------------------------------------

test('G.2.2: listSessionsForCwd matches session.directory directly', () => {
  const dir = mktmp('atem-oc-list-');
  const dbPath = makeFakeOpencodeDb(dir);
  process.env.ATEM_OPENCODE_DB = dbPath;
  try {
    seedSession(dbPath, { id: 'ses-A', directory: '/repo/here', title: 'sess A' });
    seedSession(dbPath, { id: 'ses-B', directory: '/repo/here', title: 'sess B' });
    seedSession(dbPath, { id: 'ses-C', directory: '/other/place', title: 'sess C' });
    const rows = opencodeAdapter.listSessionsForCwd('/repo/here');
    assert.equal(rows.length, 2);
    const ids = rows.map((r) => r.id).sort();
    assert.deepEqual(ids, ['ses-A', 'ses-B']);
  } finally { delete process.env.ATEM_OPENCODE_DB; }
});

test('G.2.2: archived sessions excluded by default', () => {
  const dir = mktmp('atem-oc-archived-');
  const dbPath = makeFakeOpencodeDb(dir);
  process.env.ATEM_OPENCODE_DB = dbPath;
  try {
    seedSession(dbPath, { id: 'live', directory: '/x', title: 'live one' });
    seedSession(dbPath, { id: 'old',  directory: '/x', title: 'archived', archived: Date.now() });
    const rows = opencodeAdapter.listSessionsForCwd('/x');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'live');
    const all = opencodeAdapter.listSessionsForCwd('/x', { includeArchived: true });
    assert.equal(all.length, 2);
  } finally { delete process.env.ATEM_OPENCODE_DB; }
});

test('G.2.2: distillSessionSync produces the canonical adapter shape', () => {
  const dir = mktmp('atem-oc-distill-');
  const dbPath = makeFakeOpencodeDb(dir);
  process.env.ATEM_OPENCODE_DB = dbPath;
  try {
    seedSession(dbPath, {
      id: 'ses-1', directory: '/work/repo', title: 'investigate the timeout bug',
      model: 'gpt-5-mini', mode: 'build',
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'investigate the timeout bug in src/auth.ts' }] },
        { role: 'assistant', parts: [
          { type: 'text', text: 'Traced the timeout to a missing await in token refresh.' },
        ] },
        { role: 'user', parts: [{ type: 'text', text: 'good, apply the fix' }] },
        { role: 'assistant', parts: [
          { type: 'text', text: 'Fix applied. Token refresh now awaits the network call. Tests pass.' },
        ] },
      ],
    });
    const d = opencodeAdapter.distillSessionSync('ses-1', { cwd: '/work/repo' });
    assert.equal(d.sessionId, 'ses-1');
    assert.equal(d.cwd, '/work/repo');
    assert.equal(d.model, 'gpt-5-mini');
    assert.equal(d.mode, 'build');
    assert.match(d.title, /investigate the timeout bug/);
    assert.match(d.firstTask, /investigate the timeout bug/);
    assert.match(d.lastAssistantText, /Fix applied/);
    assert.match(d.summary, /Fix applied/);
    assert.equal(d.pausedMidTool, false);
  } finally { delete process.env.ATEM_OPENCODE_DB; }
});

test('G.2.2: pausedMidTool fires when a part has status:pending', () => {
  const dir = mktmp('atem-oc-pending-');
  const dbPath = makeFakeOpencodeDb(dir);
  process.env.ATEM_OPENCODE_DB = dbPath;
  try {
    seedSession(dbPath, {
      id: 'ses-paused', directory: '/x', title: 'paused',
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'run the migration' }] },
        { role: 'assistant', parts: [
          { type: 'text', text: 'running it now' },
          { type: 'tool', tool: 'bash', callID: 'c-1', state: { status: 'pending', input: {} } },
        ] },
      ],
    });
    const d = opencodeAdapter.distillSessionSync('ses-paused');
    assert.equal(d.pausedMidTool, true);
  } finally { delete process.env.ATEM_OPENCODE_DB; }
});

test('G.2.2: distillLatestForCwd selects the newest session', () => {
  const dir = mktmp('atem-oc-latest-');
  const dbPath = makeFakeOpencodeDb(dir);
  process.env.ATEM_OPENCODE_DB = dbPath;
  try {
    seedSession(dbPath, { id: 'old', directory: '/x', title: 'old',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'first' }] }] });
    // newer mtime via separate insert (time_updated set to now in helper)
    seedSession(dbPath, { id: 'new', directory: '/x', title: 'new',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'second' }] }] });
    const d = opencodeAdapter.distillLatestForCwd('/x');
    assert.equal(d.sessionId, 'new');
    assert.match(d.firstTask, /second/);
  } finally { delete process.env.ATEM_OPENCODE_DB; }
});

// --- launcher tests -------------------------------------------------------

test('G.2.3: launcher reports unavailable when opencode is missing', async () => {
  const launcher = opencodeLauncher.makeOpencodeLauncher({ whichFn: () => null });
  assert.equal(launcher.available(), false);
  const r = await launcher.launch({ targetRepo: '/tmp', syntheticId: 'x' });
  assert.equal(r.kind, 'unavailable');
});

test('G.2.3: default launch runs `opencode run <seed> --title --dir`', async () => {
  const repo = mktmp('atem-oc-launch-');
  const calls = [];
  const fakeSpawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return Object.assign(new EventEmitter(), { unref() {}, pid: 4242 });
  };
  const launcher = opencodeLauncher.makeOpencodeLauncher({
    whichFn: () => '/usr/local/bin/opencode',
    spawnFn: fakeSpawn,
  });
  const r = await launcher.launch({
    targetRepo: repo,
    syntheticId: 'claude-code:abc',
    fromProvider: 'claude-code',
    taskType: 'implementation',
  });
  assert.equal(r.kind, 'launched');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'run');
  assert.match(calls[0].args[1], /Pick up the ATEM handoff/);
  assert.equal(calls[0].args[2], '--title');
  assert.match(calls[0].args[3], /atem: claude-code:abc/);
  assert.equal(calls[0].args[4], '--dir');
  assert.equal(calls[0].args[5], repo);
});

test('G.2.3: --no-respond opens TUI instead of running a seed turn', async () => {
  const repo = mktmp('atem-oc-norespond-');
  const calls = [];
  const fakeSpawn = (bin, args, opts) => {
    calls.push({ bin, args });
    return Object.assign(new EventEmitter(), { unref() {}, pid: 99 });
  };
  const launcher = opencodeLauncher.makeOpencodeLauncher({
    whichFn: () => '/usr/local/bin/opencode',
    spawnFn: fakeSpawn,
  });
  const r = await launcher.launch({
    targetRepo: repo,
    syntheticId: 'omp:01HX',
    noRespond: true,
  });
  assert.equal(r.kind, 'launched');
  assert.deepEqual(calls[0].args, [repo], 'no `run` subcommand — just the path');
  assert.equal(r.metadata.mode, 'tui');
});
