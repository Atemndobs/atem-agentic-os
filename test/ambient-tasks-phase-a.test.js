// Phase A tests for ambient tasks (read-only synthetic ids).
//
// Verifies:
//   - synthetic id derivation
//   - getOmpSessions stamps syntheticId
//   - atem status renders the "Detected sessions" table when an
//     ambient omp session exists
//   - atem://<synthetic>/<artifact> resolves to virtual markdown via
//     the omp adapter's resolveSynthetic (no session dir created)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'atem.js');

function mktmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}

function envFor(home) {
  return {
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: '1',
    ATEM_HANDLES_DIR: path.join(home, '.atem', 'handles'),
    PI_CODING_AGENT_DIR: path.join(home, '.omp', 'agent'),
  };
}

function runAtem(args, env) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeOmpSession(agentDir, encodedDir, sessionId, cwd, entries) {
  const dir = path.join(agentDir, 'sessions', encodedDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const header = {
    type: 'session', id: sessionId, title: 'ambient demo',
    timestamp: new Date().toISOString(), cwd,
  };
  fs.writeFileSync(file, [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))].join('\n') + '\n');
  return file;
}

test('synthetic: derive / parse / short / cwd fallback', () => {
  const s = require('../src/synthetic.js');
  const id = s.deriveSyntheticId('omp', '01HGY4Z2-abc');
  assert.equal(id, 'omp:01HGY4Z2-abc');
  assert.equal(s.isSyntheticId(id), true);
  assert.equal(s.isSyntheticId('TASK-001'), false);
  assert.deepEqual(s.parseSyntheticId(id), { provider: 'omp', providerSessionId: '01HGY4Z2-abc' });
  assert.equal(s.shortId(id, 4), 'omp:01HG');
  // sanitize
  assert.equal(s.deriveSyntheticId('omp', 'a/b c'), 'omp:a-b-c');
  // fallback
  const fb = s.cwdFallbackId('cursor', '/tmp/work');
  assert.match(fb, /^cursor:cwd-[a-f0-9]{8}$/);
});

test('atem status shows Detected sessions for an ambient omp session', () => {
  const home = mktmp('atem-amb-status-');
  const repo = path.join(home, 'work', 'demo');
  initRepo(repo);
  const env = envFor(home);
  runAtem(['init'], env);

  const omp = require('../src/adapters/omp.js');
  const agentDir = path.join(home, '.omp', 'agent');
  const encoded = omp.encodeSessionDirName(repo);
  writeOmpSession(agentDir, encoded, '01HGY4Z2-amb', repo, [
    { type: 'message', id: 'u1', parentId: null, timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'find the timeout bug' } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Located in src/auth.ts.' }] } },
  ]);

  const out = runAtem(['status'], env);
  assert.match(out, /Detected sessions/);
  assert.match(out, /omp:01HGY4/, 'short synthetic id should appear in table');
});

test('atem resolve atem://omp:<id>/state returns synthetic markdown without creating files', () => {
  const home = mktmp('atem-amb-resolve-');
  const repo = path.join(home, 'work', 'demo');
  initRepo(repo);
  const env = envFor(home);
  runAtem(['init'], env);

  const omp = require('../src/adapters/omp.js');
  const agentDir = path.join(home, '.omp', 'agent');
  const encoded = omp.encodeSessionDirName(repo);
  writeOmpSession(agentDir, encoded, 'sess-abc', repo, [
    { type: 'message', id: 'u1', parentId: null, timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'investigate retry cap' } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Cap appears wrong in auth.ts line 42.' }] } },
  ]);

  // Pre-condition: no ATEM session dir for this synthetic id.
  const sessionsDir = path.join(home, '.atem', 'harness', 'sessions');
  const before = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];

  const out = runAtem(['resolve', 'atem://omp:sess-abc/state'], env);
  assert.match(out, /State — synthetic/);
  assert.match(out, /Cap appears wrong in auth\.ts line 42\./);
  assert.match(out, /Provider: omp/);

  // Post-condition: still no materialized dir.
  const after = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
  assert.deepEqual(after, before, 'synthetic resolve must not create ATEM session dirs');
});

test('atem resolve --raw returns JSON envelope for synthetic results', () => {
  const home = mktmp('atem-amb-raw-');
  const repo = path.join(home, 'work', 'demo');
  initRepo(repo);
  const env = envFor(home);
  runAtem(['init'], env);

  const omp = require('../src/adapters/omp.js');
  const agentDir = path.join(home, '.omp', 'agent');
  const encoded = omp.encodeSessionDirName(repo);
  writeOmpSession(agentDir, encoded, 'sess-raw', repo, [
    { type: 'message', id: 'u1', parentId: null, timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'do stuff' } },
  ]);

  const out = runAtem(['resolve', 'atem://omp:sess-raw/handoff', '--raw'], env);
  const parsed = JSON.parse(out);
  assert.equal(parsed.kind, 'virtual');
  assert.equal(parsed.mimeType, 'text/markdown');
  assert.match(parsed.payload, /Handoff — synthetic/);
});

test('atem resolve atem://<synthetic>/state errors clearly when no provider session exists', () => {
  const home = mktmp('atem-amb-missing-');
  const repo = path.join(home, 'work', 'demo');
  initRepo(repo);
  const env = envFor(home);
  runAtem(['init'], env);

  assert.throws(
    () => runAtem(['resolve', 'atem://omp:does-not-exist/state'], env),
    /omp session not found|missing-file|resolve failed/,
  );
});

test('existing TASK-N workflows are not affected (regression: phase 1 + 2 tests still pass via real id)', () => {
  // Quick sanity: create a real task, resolve its state, confirm it still
  // returns a local path (not virtual). Heavy regression coverage lives
  // in the existing test files; this is a smoke check.
  const home = mktmp('atem-amb-regress-');
  const repo = path.join(home, 'work', 'demo');
  initRepo(repo);
  const env = envFor(home);
  runAtem(['init'], env);
  runAtem(['start', 'real task', '--type', 'implementation', '--repo', repo], env);
  const sessionsDir = path.join(home, '.atem', 'harness', 'sessions');
  const taskId = fs.readdirSync(sessionsDir)[0];
  const out = runAtem(['resolve', `atem://${taskId}/state`], env).trim();
  assert.ok(out.endsWith('state.md'), `expected local path, got: ${out}`);
});
