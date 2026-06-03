// W7 — H.1: recovery detection + remediation tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'atem.js');
const recovery = require('../src/recovery.js');

function mktmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

// Build the paths bundle from a known HOME without depending on cli.js
// module-load-time constants (which capture os.homedir() at first require).
function makePaths(home) {
  const harnessDir = path.join(home, '.atem', 'harness');
  return {
    mode: 'global',
    harnessDir,
    currentSessionFile: path.join(harnessDir, 'current-session.md'),
    routingFile: path.join(harnessDir, 'routing.md'),
    providerContractFile: path.join(harnessDir, 'provider-contract.md'),
    sessionsDir: path.join(harnessDir, 'sessions'),
  };
}
function envFor(home) {
  return { HOME: home, USERPROFILE: home, NO_COLOR: '1' };
}
function runAtem(args, env, cwd) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: cwd || env.HOME,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function setup() {
  const home = mktmp('atem-recover-');
  const repo = path.join(home, 'work', 'demo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  const env = envFor(home);
  runAtem(['init'], env, home);
  runAtem(['start', 'recover test', '--type', 'implementation', '--repo', repo], env, home);
  const sessionsDir = path.join(home, '.atem', 'harness', 'sessions');
  const taskId = fs.readdirSync(sessionsDir)[0];
  const paths = require('../src/cli.js').resolveActivePaths(null);
  // ATEM ran with HOME set in the subprocess; for in-process tests we
  // need to set HOME ourselves so resolveActivePaths uses the same root.
  return { home, repo, env, taskId, sessionsDir };
}

// --- detection ----------------------------------------------------------

test('H.1: detectAllIssues returns [] for a clean session', () => {
  const { home, taskId, sessionsDir } = setup();
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    const paths = makePaths(home);
    const issues = recovery.detectAllIssues(paths, { taskId });
    assert.deepEqual(issues, []);
  } finally { process.env.HOME = before; }
});

test('H.1: detectMissingFiles flags every removed required file', () => {
  const { home, taskId } = setup();
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    const paths = makePaths(home);
    const sessionDir = path.join(paths.harnessDir, 'sessions', taskId);
    fs.rmSync(path.join(sessionDir, 'next.md'));
    fs.rmSync(path.join(sessionDir, 'log.md'));
    const issues = recovery.detectMissingFiles(paths, taskId);
    const codes = issues.map((i) => i.code);
    assert.equal(issues.length, 2);
    assert.ok(codes.every((c) => c === 'missing-file'));
    const files = issues.map((i) => i.message);
    assert.ok(files.some((m) => m.includes('next.md')));
    assert.ok(files.some((m) => m.includes('log.md')));
  } finally { process.env.HOME = before; }
});

test('H.1: missing-file remedy recreates the file from template', () => {
  const { home, taskId } = setup();
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    const paths = makePaths(home);
    const sessionDir = path.join(paths.harnessDir, 'sessions', taskId);
    const missingPath = path.join(sessionDir, 'next.md');
    fs.rmSync(missingPath);
    const [issue] = recovery.detectMissingFiles(paths, taskId);
    const result = issue.remedy.apply();
    assert.match(result, /recreated next\.md/);
    assert.ok(fs.existsSync(missingPath));
    const body = fs.readFileSync(missingPath, 'utf8');
    assert.match(body, /# Next/);
  } finally { process.env.HOME = before; }
});

test('H.1: detectStaleProgress flags sessions older than threshold', () => {
  const { home, taskId } = setup();
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    const paths = makePaths(home);
    const stateFile = path.join(paths.harnessDir, 'sessions', taskId, 'state.md');
    const now = Date.now();
    // Push state.md mtime back 10 days
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
    const sec = tenDaysAgo / 1000;
    fs.utimesSync(stateFile, sec, sec);
    const issues = recovery.detectStaleProgress(paths, taskId, { now, thresholdMs: 7 * 24 * 60 * 60 * 1000 });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, 'stale-progress');
    assert.match(issues[0].message, /10d/);
  } finally { process.env.HOME = before; }
});

test('H.1: stale-progress remedy archives the session under .archived/', () => {
  const { home, taskId } = setup();
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    const paths = makePaths(home);
    const stateFile = path.join(paths.harnessDir, 'sessions', taskId, 'state.md');
    const now = Date.now();
    const tenDaysAgo = (now - 10 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(stateFile, tenDaysAgo, tenDaysAgo);
    const [issue] = recovery.detectStaleProgress(paths, taskId, { now });
    issue.remedy.apply();
    const archivedPath = path.join(paths.harnessDir, 'sessions', '.archived', taskId);
    assert.ok(fs.existsSync(archivedPath));
    const livePath = path.join(paths.harnessDir, 'sessions', taskId);
    assert.equal(fs.existsSync(livePath), false);
  } finally { process.env.HOME = before; }
});

test('H.1: detectDanglingAliases flags missing target', () => {
  const { home } = setup();
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    const paths = makePaths(home);
    const aliases = require('../src/aliases.js');
    aliases.setAlias(paths, 'ghost', 'TASK-DOES-NOT-EXIST');
    const issues = recovery.detectDanglingAliases(paths);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, 'dangling-alias-missing-task');
    // remedy removes
    issues[0].remedy.apply();
    assert.equal(aliases.resolveAlias(paths, 'ghost'), null);
  } finally { process.env.HOME = before; }
});

// --- CLI dispatch -------------------------------------------------------

test('H.1: atem recover reports clean when nothing is wrong', () => {
  const { env } = setup();
  const out = runAtem(['recover'], env);
  assert.match(out, /no issues detected/);
});

test('H.1: atem recover --json emits structured output', () => {
  const { home, env, taskId } = setup();
  const stateFile = path.join(home, '.atem', 'harness', 'sessions', taskId, 'state.md');
  // Force a stale flag
  const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(stateFile, tenDaysAgo, tenDaysAgo);
  const out = runAtem(['recover', '--json'], env);
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.some((i) => i.code === 'stale-progress'));
});

test('H.1: atem recover --fix archives a stale session end-to-end', () => {
  const { home, env, taskId } = setup();
  const stateFile = path.join(home, '.atem', 'harness', 'sessions', taskId, 'state.md');
  const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(stateFile, tenDaysAgo, tenDaysAgo);
  const out = runAtem(['recover', '--fix'], env);
  assert.match(out, /Applying/);
  const archived = path.join(home, '.atem', 'harness', 'sessions', '.archived', taskId);
  assert.ok(fs.existsSync(archived), 'session archived');
});

test('H.1: atem recover scoped to a single task ignores other tasks', () => {
  const { home, env } = setup();
  const sessionsDir = path.join(home, '.atem', 'harness', 'sessions');
  // Start a second task we'll leave clean
  runAtem(['start', 'another', '--type', 'investigation', '--repo', path.join(home, 'work', 'demo')], env, home);
  const ids = fs.readdirSync(sessionsDir).filter((n) => !n.startsWith('.'));
  assert.equal(ids.length, 2);
  // Make ONLY one of them stale
  const targetId = ids[0];
  const stateFile = path.join(sessionsDir, targetId, 'state.md');
  const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(stateFile, tenDaysAgo, tenDaysAgo);
  // Scope recover to the OTHER task
  const out = runAtem(['recover', ids[1], '--json'], env);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed, [], 'scoped recover should ignore the stale task');
});
