const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ATEM = path.join(__dirname, '..', 'bin', 'atem.js');

function makeTempHarness() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atem-archive-'));
  const env = { ...process.env, HOME: tmpHome, ATEM_HARNESS_MODE: 'global' };
  const run = (args) => execFileSync('node', [ATEM, ...args], { env, encoding: 'utf8', cwd: tmpHome });
  return { tmpHome, run };
}

test('archive moves session into _archive and stamps status', () => {
  const { tmpHome, run } = makeTempHarness();
  run(['init']);
  run(['start', 'Tmp task', '--type', 'implementation', '--repo', '/tmp/exists-not']);
  run(['archive', 'TASK-001']);
  const orig = path.join(tmpHome, '.atem', 'harness', 'sessions', 'TASK-001');
  const arch = path.join(tmpHome, '.atem', 'harness', 'sessions', '_archive', 'TASK-001');
  assert.equal(fs.existsSync(orig), false);
  assert.equal(fs.existsSync(arch), true);
  const state = fs.readFileSync(path.join(arch, 'state.md'), 'utf8');
  assert.match(state, /status: archived/);
});

test('archive --broken archives only sessions with missing repos', () => {
  const { tmpHome, run } = makeTempHarness();
  run(['init']);
  // Existing repo
  const realRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'atem-real-'));
  run(['start', 'Real task', '--type', 'implementation', '--repo', realRepo]);
  // Broken repo
  run(['start', 'Broken task', '--type', 'implementation', '--repo', '/tmp/definitely-not-there-xyz']);
  run(['archive', '--broken']);
  const t1 = path.join(tmpHome, '.atem', 'harness', 'sessions', 'TASK-001');
  const t2 = path.join(tmpHome, '.atem', 'harness', 'sessions', 'TASK-002');
  const t2Arch = path.join(tmpHome, '.atem', 'harness', 'sessions', '_archive', 'TASK-002');
  assert.equal(fs.existsSync(t1), true, 'real-repo task stays');
  assert.equal(fs.existsSync(t2), false, 'broken task moved out');
  assert.equal(fs.existsSync(t2Arch), true, 'broken task in _archive');
});

test('archive --broken --dry-run does not move anything', () => {
  const { tmpHome, run } = makeTempHarness();
  run(['init']);
  run(['start', 'Broken', '--type', 'implementation', '--repo', '/tmp/nope-xyz']);
  const out = run(['archive', '--broken', '--dry-run']);
  assert.match(out, /would-archive/);
  const t1 = path.join(tmpHome, '.atem', 'harness', 'sessions', 'TASK-001');
  assert.equal(fs.existsSync(t1), true);
});
