const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ATEM = path.join(__dirname, '..', 'bin', 'atem.js');

function makeTempHarness() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atem-snap-'));
  const env = { ...process.env, HOME: tmpHome, ATEM_HARNESS_MODE: 'global' };
  const run = (args, opts = {}) => execFileSync('node', [ATEM, ...args], {
    env,
    encoding: 'utf8',
    cwd: opts.cwd || tmpHome,
  });
  return { tmpHome, run, env };
}

function makeGitRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'init\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

test('snapshot-diff summarizes provider and file deltas', () => {
  const { run } = makeTempHarness();
  const repo = makeGitRepo('snap-repo');
  run(['init']);
  run(['start', 'Refactor', '--type', 'implementation', '--repo', repo]);
  run(['adapter', 'codex', 'update', 'TASK-001', 'provider=codex']);
  // First snapshot with no changes
  run(['snapshot', 'TASK-001', '--repo', repo]);
  // Create a working-tree change
  fs.writeFileSync(path.join(repo, 'new.txt'), 'hello\n');
  // Switch provider before second snapshot
  run(['adapter', 'claude-code', 'update', 'TASK-001', 'provider=claude-code']);
  // Sleep 1s so snapshot timestamps differ
  execFileSync('sleep', ['1']);
  run(['snapshot', 'TASK-001', '--repo', repo]);

  const out = run(['snapshot-diff', 'TASK-001']);
  assert.match(out, /codex → claude-code/);
  assert.match(out, /new\.txt/);
});

test('snapshot-diff handles too-few snapshots', () => {
  const { run } = makeTempHarness();
  const repo = makeGitRepo('snap-only');
  run(['init']);
  run(['start', 'T', '--type', 'implementation', '--repo', repo]);
  const out = run(['snapshot-diff', 'TASK-001']);
  assert.match(out, /Need at least 2 snapshots/);
});
