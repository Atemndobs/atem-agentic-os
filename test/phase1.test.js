const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI_PATH = path.resolve(__dirname, '../bin/atem.js');

function setupRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atem-phase1-'));
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  return repoDir;
}

function run(repoDir, args) {
  return execFileSync('node', [CLI_PATH, ...args], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ATEM_HARNESS_MODE: 'repo',
    },
  });
}

function runInDir(dir, args, extraEnv = {}) {
  return execFileSync('node', [CLI_PATH, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ATEM_HARNESS_MODE: 'repo',
      ...extraEnv,
    },
  });
}

function read(repoDir, relPath) {
  return fs.readFileSync(path.join(repoDir, relPath), 'utf8');
}

test('init creates .harness baseline files', () => {
  const repoDir = setupRepo();
  run(repoDir, ['init']);

  assert.ok(fs.existsSync(path.join(repoDir, '.harness/current-session.md')));
  assert.ok(fs.existsSync(path.join(repoDir, '.harness/routing.md')));
  assert.ok(fs.existsSync(path.join(repoDir, '.harness/provider-contract.md')));
  assert.ok(fs.existsSync(path.join(repoDir, '.harness/sessions')));
});

test('start creates TASK-001 with required session files', () => {
  const repoDir = setupRepo();
  run(repoDir, ['init']);
  run(repoDir, ['start', 'Fix login bug']);

  const sessionDir = path.join(repoDir, '.harness/sessions/TASK-001');
  const files = [
    'brief.md',
    'state.md',
    'handoff.md',
    'decisions.md',
    'next.md',
    'validation.md',
    'log.md',
  ];

  for (const file of files) {
    assert.ok(fs.existsSync(path.join(sessionDir, file)), `${file} should exist`);
  }
});

test('route updates current-session, state, handoff and log', () => {
  const repoDir = setupRepo();
  run(repoDir, ['init']);
  run(repoDir, ['start', 'Fix login bug']);
  run(repoDir, ['route', 'TASK-001', '--to', 'codex']);

  const currentSession = read(repoDir, '.harness/current-session.md');
  const state = read(repoDir, '.harness/sessions/TASK-001/state.md');
  const handoff = read(repoDir, '.harness/sessions/TASK-001/handoff.md');
  const log = read(repoDir, '.harness/sessions/TASK-001/log.md');

  assert.match(currentSession, /## Active Task ID\nTASK-001/);
  assert.match(state, /## Current Provider\ncodex/);
  assert.match(handoff, /## Next Suggested Provider\ncodex/);
  assert.match(log, /Routed TASK-001 from manual to codex\./);
});

test('handoff prints a complete prompt for the task', () => {
  const repoDir = setupRepo();
  run(repoDir, ['init']);
  run(repoDir, ['start', 'Fix login bug']);
  const output = run(repoDir, ['handoff', 'TASK-001']);

  assert.match(output, /You are continuing an existing coding task through ATEM\./);
  assert.match(output, /\.harness\/current-session\.md/);
  assert.match(output, /\.harness\/sessions\/TASK-001\/handoff\.md/);
  assert.match(output, /Never end the session without updating `handoff\.md`\./);
});

test('handoff can route to provider with --to', () => {
  const repoDir = setupRepo();
  run(repoDir, ['init']);
  run(repoDir, ['start', 'Fix login bug']);
  const output = run(repoDir, ['handoff', 'TASK-001', '--to', 'codex']);

  const state = read(repoDir, '.harness/sessions/TASK-001/state.md');
  assert.match(state, /## Current Provider\ncodex/);
  assert.match(output, /## Target Provider\ncodex/);
});

test('close marks state complete and logs closure', () => {
  const repoDir = setupRepo();
  run(repoDir, ['init']);
  run(repoDir, ['start', 'Fix login bug']);
  run(repoDir, ['close', 'TASK-001']);

  const state = read(repoDir, '.harness/sessions/TASK-001/state.md');
  const log = read(repoDir, '.harness/sessions/TASK-001/log.md');

  assert.match(state, /## Status\ncomplete/);
  assert.match(log, /Task closed\./);
});

test('status prints no-active message when no harness task exists', () => {
  const repoDir = setupRepo();
  run(repoDir, ['init']);
  const output = run(repoDir, ['status']);

  assert.match(output, /ATEM status/);
  assert.match(output, /Machine-wide provider activity/);
  assert.match(output, /ATEM context:/);
  assert.match(output, /active task: none/);
});

test('status works outside a git repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atem-nongit-'));
  const output = runInDir(dir, ['status']);

  assert.match(output, /ATEM status/);
  assert.match(output, /ATEM context:/);
  assert.match(output, /no git repository detected/);
});

test('status --repo scopes provider activity to that repository', () => {
  const repoDir = setupRepo();
  run(repoDir, ['init']);

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atem-home-'));
  fs.mkdirSync(path.join(fakeHome, '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });

  const otherRepo = '/tmp/other-repo';
  const inRepoSession = {
    pid: process.pid,
    sessionId: 'in-repo',
    cwd: repoDir,
    startedAt: Date.now(),
    entrypoint: 'claude-desktop',
  };
  const outRepoSession = {
    pid: process.pid,
    sessionId: 'out-repo',
    cwd: otherRepo,
    startedAt: Date.now() - 1000,
    entrypoint: 'claude-desktop',
  };

  fs.writeFileSync(
    path.join(fakeHome, '.claude', 'sessions', 'in.json'),
    JSON.stringify(inRepoSession),
    'utf8'
  );
  fs.writeFileSync(
    path.join(fakeHome, '.claude', 'sessions', 'out.json'),
    JSON.stringify(outRepoSession),
    'utf8'
  );

  const codexState = {
    'active-workspace-roots': [repoDir, otherRepo],
    'electron-saved-workspace-roots': [repoDir, otherRepo],
  };
  fs.writeFileSync(
    path.join(fakeHome, '.codex', '.codex-global-state.json'),
    JSON.stringify(codexState),
    'utf8'
  );

  const output = runInDir(repoDir, ['status', '--repo', '.'], { HOME: fakeHome });
  assert.match(output, /Machine-wide provider activity \(scoped to /);
  assert.match(output, new RegExp(repoDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(output, new RegExp(otherRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('adopt writes active providers section into state', () => {
  const repoDir = setupRepo();
  run(repoDir, ['init']);
  run(repoDir, ['start', 'Fix login bug']);
  run(repoDir, ['adopt', 'TASK-001']);

  const state = read(repoDir, '.harness/sessions/TASK-001/state.md');
  const log = read(repoDir, '.harness/sessions/TASK-001/log.md');
  assert.match(state, /## Active Providers/);
  assert.match(log, /Adopted active provider sessions/);
});
