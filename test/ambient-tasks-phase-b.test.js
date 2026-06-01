// Phase B tests for ambient tasks: materialization, aliases,
// adopt --auto, handoff over synthetic ids, task-type inference,
// handle-farm alias symlinks, and doctor checks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'atem.js');

function mktmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}
function envFor(home) {
  return {
    HOME: home, USERPROFILE: home, NO_COLOR: '1',
    ATEM_HANDLES_DIR: path.join(home, '.atem', 'handles'),
    PI_CODING_AGENT_DIR: path.join(home, '.omp', 'agent'),
  };
}
function runAtem(args, env, cwd) {
  // Default cwd to the test's tmp HOME (outside any git repo) so that
  // `init` and every other command consistently use the global harness
  // under <HOME>/.atem/harness. Otherwise `init` writes to <repo>/.harness
  // while `doctor` reads from global, masking real failures.
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: cwd || env.HOME,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function writeOmpSession(agentDir, encodedDir, sessionId, cwd, entries) {
  const dir = path.join(agentDir, 'sessions', encodedDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', id: sessionId, cwd, timestamp: new Date().toISOString(), title: 'amb-b' }),
    ...entries.map((e) => JSON.stringify(e)),
  ].join('\n') + '\n');
  return file;
}

function setupAmbient({ task = 'find the timeout bug', mode = 'none' } = {}) {
  const home = mktmp('atem-amb-b-');
  const repo = path.join(home, 'work', 'demo');
  initRepo(repo);
  const env = envFor(home);
  runAtem(['init'], env);
  const omp = require('../src/adapters/omp.js');
  const encoded = omp.encodeSessionDirName(repo);
  const entries = [
    { type: 'session_init', id: 'i1', parentId: null, timestamp: new Date().toISOString(), task, tools: ['read'] },
    { type: 'message', id: 'u1', parentId: 'i1', timestamp: new Date().toISOString(),
      message: { role: 'user', content: task } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Found suspect in src/auth.ts.' }] } },
  ];
  if (mode !== 'none') {
    entries.push({ type: 'mode_change', id: 'mc1', parentId: 'a1', timestamp: new Date().toISOString(), mode });
  }
  writeOmpSession(path.join(home, '.omp', 'agent'), encoded, 'sess-B1', repo, entries);
  return { home, repo, env, syntheticId: 'omp:sess-B1' };
}

test('handoff <synthetic> materializes the task dir on first use', () => {
  const { home, repo, env, syntheticId } = setupAmbient();
  const sessionsDir = path.join(home, '.atem', 'harness', 'sessions');
  assert.equal(fs.existsSync(path.join(sessionsDir, syntheticId)), false, 'precondition: not materialized');

  const out = runAtem(['handoff', syntheticId, '--to', 'codex', '--repo', repo], env);
  assert.match(out, /# ATEM Session Handoff/);
  const dir = path.join(sessionsDir, syntheticId);
  assert.ok(fs.existsSync(dir), 'synthetic id should now be materialized');
  const brief = fs.readFileSync(path.join(dir, 'brief.md'), 'utf8');
  assert.match(brief, /find the timeout bug/i, 'brief should carry the omp first-task');
  const state = fs.readFileSync(path.join(dir, 'state.md'), 'utf8');
  assert.match(state, /Found suspect in src\/auth\.ts/);
});

test('adopt <synthetic> --name <alias> writes alias and materializes', () => {
  const { home, env, syntheticId } = setupAmbient();
  runAtem(['adopt', syntheticId, '--name', 'fix-timeout'], env);
  const aliasesFile = path.join(home, '.atem', 'harness', 'sessions', '.aliases.json');
  const table = JSON.parse(fs.readFileSync(aliasesFile, 'utf8'));
  assert.equal(table['fix-timeout'], syntheticId);

  // atem://fix-timeout/state should resolve through the alias.
  const out = runAtem(['resolve', 'atem://fix-timeout/state'], env).trim();
  assert.ok(out.endsWith('state.md'), `expected materialized state.md path, got: ${out}`);
  // handle farm carries the alias symlink
  const aliasLink = path.join(home, '.atem', 'handles', 'fix-timeout');
  assert.ok(fs.existsSync(aliasLink), 'alias symlink should exist under handles farm');
});

test('adopt --auto materializes every detected ambient session', () => {
  const { home, env, syntheticId } = setupAmbient();
  const out = runAtem(['adopt', '--auto'], env);
  assert.match(out, /Materialized 1 ambient task/);
  const sessionsDir = path.join(home, '.atem', 'harness', 'sessions');
  assert.ok(fs.existsSync(path.join(sessionsDir, syntheticId)));
  // Re-running should skip.
  const out2 = runAtem(['adopt', '--auto'], env);
  assert.match(out2, /skipped 1 already materialized/);
});

test('task type inference: omp first-task containing "find" → investigation', () => {
  const { home, env, syntheticId } = setupAmbient({ task: 'investigate why login fails intermittently' });
  runAtem(['adopt', syntheticId, '--name', 'login-flake'], env);
  const dir = path.join(home, '.atem', 'harness', 'sessions', syntheticId);
  const brief = fs.readFileSync(path.join(dir, 'brief.md'), 'utf8');
  assert.match(brief, /Task type: investigation/);
});

test('task type inference: omp first-task containing "implement" → implementation', () => {
  const { home, env, syntheticId } = setupAmbient({ task: 'implement OAuth refresh-token flow' });
  runAtem(['adopt', syntheticId, '--name', 'oauth-refresh'], env);
  const dir = path.join(home, '.atem', 'harness', 'sessions', syntheticId);
  const brief = fs.readFileSync(path.join(dir, 'brief.md'), 'utf8');
  assert.match(brief, /Task type: implementation/);
});

test('task type inference: omp mode=plan → investigation', () => {
  const { home, env, syntheticId } = setupAmbient({ task: 'fix the cap', mode: 'plan' });
  runAtem(['adopt', syntheticId, '--name', 'cap-plan'], env);
  const dir = path.join(home, '.atem', 'harness', 'sessions', syntheticId);
  const brief = fs.readFileSync(path.join(dir, 'brief.md'), 'utf8');
  assert.match(brief, /Task type: investigation/);
});

test('alias → synthetic round-trip via handoff', () => {
  const { home, repo, env, syntheticId } = setupAmbient();
  runAtem(['adopt', syntheticId, '--name', 'flake'], env);
  const out = runAtem(['handoff', 'flake', '--to', 'codex', '--repo', repo], env);
  assert.match(out, /# ATEM Session Handoff/);
  assert.match(out, /Task[^\n]*\n[^\n]*omp:sess-B1/);
});

test('doctor warns on alias pointing at missing task', () => {
  const { home, env } = setupAmbient();
  // Inject a broken alias.
  const aliasesFile = path.join(home, '.atem', 'harness', 'sessions', '.aliases.json');
  fs.mkdirSync(path.dirname(aliasesFile), { recursive: true });
  fs.writeFileSync(aliasesFile, JSON.stringify({ 'ghost': 'TASK-DOES-NOT-EXIST' }, null, 2));
  const out = runAtem(['doctor'], env);
  assert.match(out, /alias "ghost".*missing task/);
});

test('atem url handles lists materialized ids and alias symlinks', () => {
  const { home, env, syntheticId } = setupAmbient();
  runAtem(['adopt', syntheticId, '--name', 'flake2'], env);
  const out = runAtem(['url', 'handles'], env);
  const parsed = JSON.parse(out);
  assert.ok(parsed.tasks.includes(syntheticId));
  assert.ok(parsed.tasks.includes('flake2') || fs.existsSync(path.join(home, '.atem', 'handles', 'flake2')));
});

test('synthetic resolve still virtual when no materialized dir (Phase A still works)', () => {
  const { env } = setupAmbient();
  const out = runAtem(['resolve', 'atem://omp:sess-B1/handoff'], env);
  // Should be virtual markdown (synthetic banner)
  assert.match(out, /synthetic view of omp:sess-B1|Handoff — synthetic/);
});
