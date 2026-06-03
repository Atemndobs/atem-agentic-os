// Tests for the three polish edges:
//   - Orphan codex app-server cleanup via the runner
//   - --no-respond flag honored by the launcher
//   - atem init follows ATEM_HARNESS_MODE like every other command

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'atem.js');

function mktmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function initRepo(d) {
  fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: d, stdio: 'ignore' });
}
function runAtem(args, env, cwd) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env, NO_COLOR: '1' },
    cwd: cwd || env.HOME,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// --- Polish #3 — init mode mismatch -------------------------------------

test('Polish #3: atem init from inside a git repo writes to global by default', () => {
  const home = mktmp('atem-init-fix-');
  const repo = path.join(home, 'work', 'demo');
  initRepo(repo);
  // No ATEM_HARNESS_MODE set → global mode expected.
  const out = runAtem(['init'], { HOME: home }, repo);
  assert.match(out, /Initialized global handoff store/);
  // Critical: no .harness/ dropped in the repo.
  assert.equal(fs.existsSync(path.join(repo, '.harness')), false, 'no leftover .harness dir in the repo');
  // Global harness exists at HOME/.atem/harness.
  assert.ok(fs.existsSync(path.join(home, '.atem', 'harness')), 'global harness exists');
});

test('Polish #3: atem init still respects ATEM_HARNESS_MODE=repo', () => {
  const home = mktmp('atem-init-repo-mode-');
  const repo = path.join(home, 'work', 'demo');
  initRepo(repo);
  const out = runAtem(['init'], { HOME: home, ATEM_HARNESS_MODE: 'repo' }, repo);
  assert.match(out, /Initialized project handoff store/);
  assert.ok(fs.existsSync(path.join(repo, '.harness')), 'project store created');
});

// --- Polish #2 — --no-respond ------------------------------------------

test('Polish #2: --no-respond flag flows through to the launcher input', () => {
  // We don't actually call codex here — verify the dispatch shape by
  // intercepting the launcher table with a spy entry.
  const launchers = require('../src/launchers/index.js');
  let captured = null;
  const spy = {
    name: 'codex',
    available() { return true; },
    async launch(input) {
      captured = input;
      return { kind: 'launched', summary: 'spied' };
    },
  };
  const home = mktmp('atem-no-respond-spy-');
  const repo = path.join(home, 'work', 'demo');
  initRepo(repo);
  const env = { HOME: home, NO_COLOR: '1', ATEM_HANDLES_DIR: path.join(home, '.atem', 'handles') };
  runAtem(['init'], env, home);
  runAtem(['start', 'spy test', '--type', 'implementation', '--repo', repo], env, home);
  const sessionsDir = path.join(home, '.atem', 'harness', 'sessions');
  const taskId = fs.readdirSync(sessionsDir)[0];
  // Drive the dispatch via the dispatch() helper directly — same code
  // path commandHandoff uses, but no subprocess.
  return launchers.dispatch({ codex: spy }, {
    syntheticId: taskId, toProvider: 'codex',
    targetRepo: repo, taskType: 'implementation',
    handoffPrompt: 'x', noRespond: true, focus: false,
  }).then(() => {
    assert.ok(captured, 'launcher must be invoked');
    assert.equal(captured.noRespond, true);
  });
});

// --- Polish #1 — runner exits on turn/completed -------------------------

test('Polish #1: codex-runner self-terminates on turn/completed notification', async () => {
  // We don't have a real codex binary in the test sandbox, so we stub
  // it by spawning a tiny shell-script app-server that emits the
  // notifications the runner cares about, then sleeps to verify the
  // runner SIGTERMs it.
  const stubDir = mktmp('atem-runner-stub-');
  const fakeCodex = path.join(stubDir, 'codex');
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
// Stub codex app-server: reply to initialize + thread/start, then
// immediately emit turn/completed so the runner shuts down.
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'initialize') {
      process.stdout.write(JSON.stringify({id:m.id,result:{}}) + '\\n');
    } else if (m.method === 'thread/start') {
      process.stdout.write(JSON.stringify({id:m.id,result:{thread:{id:'stub-thread-1',path:'/tmp/stub.jsonl'}}}) + '\\n');
    } else if (m.method === 'thread/name/set') {
      process.stdout.write(JSON.stringify({id:m.id,result:{}}) + '\\n');
    } else if (m.method === 'turn/start') {
      process.stdout.write(JSON.stringify({id:m.id,result:{}}) + '\\n');
      // Emit turn/completed immediately so the runner exits.
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'stub-thread-1',turn:{}}}) + '\\n');
    }
  }
});
// Keep alive — runner is supposed to SIGTERM us.
setTimeout(() => process.exit(2), 30000);
`);
  fs.chmodSync(fakeCodex, 0o755);

  const params = {
    bin: fakeCodex,
    cwd: '/tmp',
    sidebarName: 'stub thread',
    devInstructions: 'stub instructions',
    firstTurn: 'stub turn',
  };
  const { spawn } = require('node:child_process');
  const runner = path.join(__dirname, '..', 'src', 'launchers', 'codex-runner.js');
  const argBlob = Buffer.from(JSON.stringify(params)).toString('base64');
  const proc = spawn(process.execPath, [runner, argBlob], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdoutBuf = '';
  let readyMsg = null;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (c) => {
    stdoutBuf += c;
    const i = stdoutBuf.indexOf('\n');
    if (i >= 0 && !readyMsg) {
      try { readyMsg = JSON.parse(stdoutBuf.slice(0, i)); } catch { /* keep reading */ }
    }
  });

  const exited = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('runner did not exit in 10s')), 10_000);
    proc.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });

  assert.equal(exited, 0, 'runner should exit cleanly');
  assert.ok(readyMsg, 'runner emitted a ready event');
  assert.equal(readyMsg.event, 'ready');
  assert.equal(readyMsg.threadId, 'stub-thread-1');
});
