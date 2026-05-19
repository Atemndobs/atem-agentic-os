const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ATEM = path.join(__dirname, '..', 'bin', 'atem.js');

function makeTempHarness() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atem-adapter-'));
  const env = { ...process.env, HOME: tmpHome, ATEM_HARNESS_MODE: 'global' };
  const run = (args, opts = {}) => execFileSync('node', [ATEM, ...args], {
    env,
    encoding: 'utf8',
    cwd: opts.cwd || tmpHome,
  });
  return { tmpHome, run };
}

test('adapter read reflects start metadata', () => {
  const { run } = makeTempHarness();
  run(['init']);
  run(['start', 'Refactor auth module', '--type', 'implementation', '--repo', '/tmp/example']);
  const out = run(['adapter', 'codex', 'read', 'TASK-001']);
  const data = JSON.parse(out);
  assert.equal(data.task_id, 'TASK-001');
  assert.equal(data.task_type, 'implementation');
  assert.equal(data.repo, '/tmp/example');
  assert.equal(data.schema, 'atem.session.v1');
});

test('adapter update writes provider and summary', () => {
  const { run } = makeTempHarness();
  run(['init']);
  run(['start', 'Add OAuth flow', '--type', 'implementation', '--repo', '/tmp/x']);
  const out = run(['adapter', 'claude-code', 'update', 'TASK-001', 'summary=Wired login route', 'status=active']);
  const data = JSON.parse(out);
  assert.equal(data.provider, 'claude-code');
  assert.equal(data.summary, 'Wired login route');
  assert.equal(data.status, 'active');
});

test('adapter log appends to log.md', () => {
  const { tmpHome, run } = makeTempHarness();
  run(['init']);
  run(['start', 'Trace prod incident', '--type', 'investigation', '--repo', '/tmp/y']);
  run(['adapter', 'codex', 'log', 'TASK-001', 'Pulled traces from raindrop']);
  const logPath = path.join(tmpHome, '.atem', 'harness', 'sessions', 'TASK-001', 'log.md');
  const content = fs.readFileSync(logPath, 'utf8');
  assert.match(content, /\[codex\] Pulled traces from raindrop/);
});

test('adapter rejects unknown provider', () => {
  const { run } = makeTempHarness();
  run(['init']);
  run(['start', 'Test', '--type', 'implementation', '--repo', '/tmp/z']);
  assert.throws(() => run(['adapter', 'nope', 'read', 'TASK-001']), /Unknown provider/);
});
