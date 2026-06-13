const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ATEM = path.join(__dirname, '..', 'bin', 'atem.js');

function makeTempHarness() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atem-web-cli-'));
  const env = {
    ...process.env,
    HOME: tmpHome,
    ATEM_HARNESS_MODE: 'global',
    ATEM_WEB_CLAUDE_PROJECTS_DIR: path.join(tmpHome, 'no-claude'),
    ATEM_WEB_CODEX_SESSIONS_DIR: path.join(tmpHome, 'no-codex'),
  };
  delete env.ATEM_HANDLES_DIR;
  const run = (args, opts = {}) => execFileSync('node', [ATEM, ...args], {
    env,
    encoding: 'utf8',
    cwd: opts.cwd || tmpHome,
  });
  return { tmpHome, env, run };
}

test('help mentions web', () => {
  const { run } = makeTempHarness();
  assert.match(run(['--help']), /atem web \[--port/);
});

test('atem web rejects unknown flags', () => {
  const { run } = makeTempHarness();
  assert.throws(() => run(['web', '--bogus']), /Usage: atem web/);
});

test('atem web serves the tree over http', async (t) => {
  const { env, run, tmpHome } = makeTempHarness();
  run(['init']);
  run(['start', 'Test task', '--repo', tmpHome]);

  const child = spawn('node', [ATEM, 'web', '--no-open', '--port', '0'], { env, cwd: tmpHome });
  t.after(() => child.kill());

  const url = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('no url in output: ' + out)), 10000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/(http:\/\/127\.0\.0\.1:\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', () => reject(new Error('exited early: ' + out)));
  });

  const tree = await (await fetch(url + '/api/tree')).json();
  assert.ok(Array.isArray(tree.groups));
  assert.equal(tree.groups[0].kind, 'tasks');
  assert.ok(tree.groups[0].nodes.some((n) => n.label === 'TASK-001'));

  const page = await (await fetch(url + '/')).text();
  assert.match(page, /atem-web-app/);
});
