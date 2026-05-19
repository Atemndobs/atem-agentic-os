const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ATEM = path.join(__dirname, '..', 'bin', 'atem.js');

function makeTempHarness() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atem-repos-'));
  const env = { ...process.env, HOME: tmpHome, ATEM_HARNESS_MODE: 'global' };
  const run = (args) => execFileSync('node', [ATEM, ...args], { env, encoding: 'utf8', cwd: tmpHome });
  return { tmpHome, run };
}

test('repos add stores path and list shows it', () => {
  const { run } = makeTempHarness();
  run(['init']);
  const repo1 = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-'));
  const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-'));
  run(['start', 'Cross-repo task', '--type', 'implementation', '--repo', repo1]);
  run(['repos', 'TASK-001', 'add', repo2]);
  const out = run(['repos', 'TASK-001', 'list']);
  assert.match(out, new RegExp(repo1));
  assert.match(out, new RegExp(repo2));
});

test('repos list flags missing paths', () => {
  const { run } = makeTempHarness();
  run(['init']);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'r-'));
  run(['start', 'T', '--type', 'implementation', '--repo', repo]);
  run(['repos', 'TASK-001', 'add', '/tmp/never-exists-xyz']);
  const out = run(['repos', 'TASK-001', 'list']);
  assert.match(out, /MISSING/);
});
