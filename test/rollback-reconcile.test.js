// W7 — H.2 (rollback) + H.3 (reconcile) tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'atem.js');

function mktmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function envFor(home) { return { HOME: home, USERPROFILE: home, NO_COLOR: '1' }; }
function runAtem(args, env, cwd) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: cwd || env.HOME,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function setup() {
  const home = mktmp('atem-w7-');
  const repo = path.join(home, 'work', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
  const env = envFor(home);
  runAtem(['init'], env, home);
  runAtem(['start', 'rollback test', '--type', 'implementation', '--repo', repo], env, home);
  const sessionsDir = path.join(home, '.atem', 'harness', 'sessions');
  const taskId = fs.readdirSync(sessionsDir)[0];
  return { home, repo, env, taskId, sessionsDir };
}

// --- H.2 rollback -------------------------------------------------------

test('H.2: rollback --list shows snapshot directory names', () => {
  const { env, taskId, repo } = setup();
  runAtem(['snapshot', taskId, '--repo', repo], env);
  // Wait a millisecond to ensure stamps differ
  const beforeSecond = Date.now();
  while (Date.now() - beforeSecond < 1500) { /* spin a tiny bit so stamps differ */ }
  runAtem(['snapshot', taskId, '--repo', repo], env);
  const out = runAtem(['rollback', taskId, '--list'], env);
  assert.match(out, /Stamp/);
  // Should list two stamps
  const matches = out.match(/^\| 2026/gm) || out.match(/^│ 2026/gm) || [];
  // No-color tables can use either fence; just count stamp rows roughly
  const stampLines = (out.match(/2026/g) || []).length;
  assert.ok(stampLines >= 2, `expected ≥ 2 snapshot rows, output: ${out}`);
});

test('H.2: rollback (default) restores state.md from the latest snapshot', () => {
  const { home, env, taskId, repo, sessionsDir } = setup();
  // Snapshot when state says "active"
  runAtem(['snapshot', taskId, '--repo', repo], env);
  // Mutate state.md to a known string
  const statePath = path.join(sessionsDir, taskId, 'state.md');
  fs.writeFileSync(statePath, '# State\n\n## Status\nbroken\n\n## Current Summary\ngarbage\n');
  // Rollback
  const out = runAtem(['rollback', taskId], env);
  assert.match(out, /Restored from snapshot/);
  assert.match(out, /Safety snapshot saved as/);
  const restored = fs.readFileSync(statePath, 'utf8');
  assert.ok(!/garbage/.test(restored), 'mutated state should be gone after rollback');
  assert.match(restored, /Status/);
});

test('H.2: rollback --dry-run does not modify anything', () => {
  const { env, taskId, repo, sessionsDir, home } = setup();
  runAtem(['snapshot', taskId, '--repo', repo], env);
  const statePath = path.join(sessionsDir, taskId, 'state.md');
  fs.writeFileSync(statePath, '# State\n\n## Status\nMUTANT\n');
  const out = runAtem(['rollback', taskId, '--dry-run'], env);
  assert.match(out, /dry run/);
  // Mutation must remain — dry run wrote nothing
  const after = fs.readFileSync(statePath, 'utf8');
  assert.match(after, /MUTANT/);
});

test('H.2: rollback --to <stamp> restores the chosen snapshot', () => {
  const { env, taskId, repo, sessionsDir } = setup();
  runAtem(['snapshot', taskId, '--repo', repo], env);
  // Mutate, snapshot again, mutate more
  const statePath = path.join(sessionsDir, taskId, 'state.md');
  fs.writeFileSync(statePath, '# State\n\n## Status\nv2\n');
  // Pause so stamp differs
  const t = Date.now(); while (Date.now() - t < 1500) {}
  runAtem(['snapshot', taskId, '--repo', repo], env);
  fs.writeFileSync(statePath, '# State\n\n## Status\nv3\n');

  // List to grab the first stamp
  const list = runAtem(['rollback', taskId, '--list'], env);
  // Find any 2026-... fragment
  // Capture full snapshot stamps like 2026-06-03-0846 (with optional -NN suffix)
  const stamps = [...new Set((list.match(/2026-\d{2}-\d{2}-\d{4}(?:-\d+)?/g) || []))].sort();
  assert.ok(stamps.length >= 2, `need ≥ 2 stamps, got ${stamps.length}`);
  const oldest = stamps[0];

  runAtem(['rollback', taskId, '--to', oldest], env);
  const after = fs.readFileSync(statePath, 'utf8');
  // The OLDEST snapshot was taken before "v2"; restoring it should
  // produce the original Status (active), not v2 or v3.
  assert.ok(!/v2/.test(after));
  assert.ok(!/v3/.test(after));
});

// --- H.3 reconcile ------------------------------------------------------

test('H.3: reconcile shows no drift when surfaces agree', () => {
  const { env, taskId } = setup();
  const out = runAtem(['reconcile', taskId], env);
  assert.match(out, /no drift/);
});

test('H.3: reconcile --json reports drift as a structured object', () => {
  const { env, taskId, home, sessionsDir } = setup();
  // Force drift: set Current Provider in current-session.md to something
  // different from what state.md says.
  const currentSessionFile = path.join(home, '.atem', 'harness', 'current-session.md');
  let cur = fs.readFileSync(currentSessionFile, 'utf8');
  cur = cur.replace(/## Current Provider\s*\n[^\n#]*/, '## Current Provider\ncodex');
  fs.writeFileSync(currentSessionFile, cur);
  const statePath = path.join(sessionsDir, taskId, 'state.md');
  let state = fs.readFileSync(statePath, 'utf8');
  state = state.replace(/## Current Provider\s*\n[^\n#]*/, '## Current Provider\nclaude-code');
  fs.writeFileSync(statePath, state);

  const out = runAtem(['reconcile', taskId, '--json'], env);
  const parsed = JSON.parse(out);
  assert.equal(parsed.drift, true);
  assert.ok(parsed.uniqueValues.length >= 2);
});

test('H.3: --unify <provider> writes the same provider to every surface', () => {
  const { env, taskId, home, sessionsDir } = setup();
  // Force drift first
  const currentSessionFile = path.join(home, '.atem', 'harness', 'current-session.md');
  let cur = fs.readFileSync(currentSessionFile, 'utf8');
  cur = cur.replace(/## Current Provider\s*\n[^\n#]*/, '## Current Provider\ncodex');
  fs.writeFileSync(currentSessionFile, cur);

  const out = runAtem(['reconcile', taskId, '--unify', 'cursor'], env);
  assert.match(out, /Unifying/);

  // Verify all surfaces are now 'cursor'
  const finalCur = fs.readFileSync(currentSessionFile, 'utf8');
  assert.match(finalCur, /## Current Provider\s*\ncursor/);
  const finalState = fs.readFileSync(path.join(sessionsDir, taskId, 'state.md'), 'utf8');
  assert.match(finalState, /## Current Provider\s*\ncursor/);
  assert.match(finalState, /provider:\s*cursor/);
});

test('H.3: --unify rejects unknown providers', () => {
  const { env, taskId } = setup();
  assert.throws(
    () => runAtem(['reconcile', taskId, '--unify', 'not-a-provider'], env),
    /Unknown provider/,
  );
});
