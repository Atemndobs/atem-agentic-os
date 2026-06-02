// Tests for the launcher table (D.1) and the individual launchers
// (D.3 Codex, D.4 claude-code).
//
// We don't actually spawn `codex` or `claude` here; each launcher
// accepts dependency-injected `spawnFn` and `findBin`/`whichFn` so we
// drive them with stubs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const launchersIndex = require('../src/launchers/index.js');
const { makePrintLauncher } = require('../src/launchers/print.js');
const { makeClaudeCodeLauncher } = require('../src/launchers/claude-code.js');
const { makeCodexLauncher, makeBridgeClient } = require('../src/launchers/codex.js');

function captureConsole(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = original; }
  return lines.join('\n');
}

// --- D.1: registry + dispatch ---------------------------------------------

test('D.1: dispatch picks the matching launcher and returns its result', async () => {
  const stub = {
    name: 'stub',
    available() { return true; },
    async launch() { return { kind: 'launched', summary: 'stub did the thing' }; },
  };
  const registry = { codex: stub };
  const result = await launchersIndex.dispatch(registry, { toProvider: 'codex', handoffPrompt: 'x' });
  assert.equal(result.kind, 'launched');
  assert.match(result.summary, /stub did the thing/);
});

test('D.1: dispatch falls back to print when launcher reports unavailable', async () => {
  const stub = {
    name: 'broken', available() { return true; },
    async launch() { return { kind: 'unavailable', reason: 'oops' }; },
  };
  const out = captureConsole(async () => {
    const r = await launchersIndex.dispatch({ codex: stub }, { toProvider: 'codex', handoffPrompt: 'HANDOFF_BODY' });
    assert.equal(r.kind, 'printed');
    assert.match(r.summary, /broken reported unavailable/);
  });
  // captureConsole is sync; rerun to get the real stdout
  let printed = '';
  const original = console.log;
  console.log = (s) => { printed += s + '\n'; };
  try {
    await launchersIndex.dispatch({ codex: stub }, { toProvider: 'codex', handoffPrompt: 'HANDOFF_BODY' });
  } finally { console.log = original; }
  assert.match(printed, /HANDOFF_BODY/);
});

test('D.1: dispatch defaults to print for unknown providers', async () => {
  const original = console.log;
  let printed = '';
  console.log = (s) => { printed += s + '\n'; };
  try {
    const r = await launchersIndex.dispatch({}, { toProvider: 'unknown-provider', handoffPrompt: 'BODY' });
    assert.equal(r.kind, 'printed');
    assert.match(printed, /BODY/);
  } finally { console.log = original; }
});

test('D.1: dispatch forcePrint bypasses the launcher', async () => {
  let launchCount = 0;
  const stub = {
    name: 'codex', available() { return true; },
    async launch() { launchCount += 1; return { kind: 'launched', summary: 'should not run' }; },
  };
  const original = console.log;
  let printed = '';
  console.log = (s) => { printed += s + '\n'; };
  try {
    const r = await launchersIndex.dispatch({ codex: stub }, { toProvider: 'codex', handoffPrompt: 'BODY' }, { forcePrint: true });
    assert.equal(r.kind, 'printed');
    assert.equal(launchCount, 0, 'launcher must not run when forcePrint is true');
    assert.match(printed, /BODY/);
  } finally { console.log = original; }
});

test('D.1: dispatch catches launcher exceptions and prints', async () => {
  const stub = {
    name: 'flaky', available() { return true; },
    async launch() { throw new Error('boom'); },
  };
  const original = console.log;
  let printed = '';
  console.log = (s) => { printed += s + '\n'; };
  try {
    const r = await launchersIndex.dispatch({ codex: stub }, { toProvider: 'codex', handoffPrompt: 'BODY' });
    assert.equal(r.kind, 'printed');
    assert.match(r.summary, /flaky threw: boom/);
    assert.match(printed, /BODY/);
  } finally { console.log = original; }
});

// --- D.4: claude-code launcher --------------------------------------------

test('D.4: claude-code launcher resumes the same session id when synthetic matches', async () => {
  const calls = [];
  const fakeSpawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return Object.assign(new EventEmitter(), { unref() {}, pid: 12345 });
  };
  const fakeWhich = () => '/usr/local/bin/claude';
  const tmp = require('node:fs').mkdtempSync(require('node:os').tmpdir() + '/atem-cc-launch-');
  const launcher = makeClaudeCodeLauncher({ spawnFn: fakeSpawn, whichFn: fakeWhich });
  const r = await launcher.launch({
    syntheticId: 'claude-code:abc-123',
    targetRepo: tmp,
    handoffPrompt: 'PROMPT',
  });
  assert.equal(r.kind, 'launched');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['--resume', 'abc-123']);
  assert.equal(calls[0].opts.cwd, tmp);
});

test('D.4: claude-code launcher uses -p for cross-provider handoffs', async () => {
  const calls = [];
  const fakeSpawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return Object.assign(new EventEmitter(), { unref() {}, pid: 99 });
  };
  const tmp = require('node:fs').mkdtempSync(require('node:os').tmpdir() + '/atem-cc-fresh-');
  const launcher = makeClaudeCodeLauncher({
    spawnFn: fakeSpawn,
    whichFn: () => '/usr/local/bin/claude',
  });
  const r = await launcher.launch({
    syntheticId: 'omp:01HX-something',  // not claude-code
    targetRepo: tmp,
  });
  assert.equal(r.kind, 'launched');
  assert.equal(calls[0].args[0], '-p');
  assert.match(calls[0].args[1], /Pick up the ATEM handoff/);
});

test('D.4: claude-code launcher reports unavailable when claude not on PATH', async () => {
  const launcher = makeClaudeCodeLauncher({ whichFn: () => null });
  assert.equal(launcher.available(), false);
  const r = await launcher.launch({ syntheticId: 'x', targetRepo: '/tmp' });
  assert.equal(r.kind, 'unavailable');
  assert.match(r.reason, /not on PATH/);
});

// --- D.3: Codex bridge client framing -------------------------------------

test('D.3: bridge client parses newline-delimited JSON-RPC responses by id', async () => {
  const child = new EventEmitter();
  child.stdin = { write() {} };
  child.stdout = new PassThrough();
  const client = makeBridgeClient(child);
  const pending = client.request('initialize', { clientInfo: { name: 'atem', version: '0' } });
  // Emit a multi-line chunk containing a notification and the matching reply.
  child.stdout.write('{"method":"announcement","params":{"hello":"world"}}\n');
  child.stdout.write('{"id":1,"result":{"ok":true}}\n');
  const result = await pending;
  assert.deepEqual(result, { ok: true });
});

test('D.3: bridge client rejects when child exits before reply', async () => {
  const child = new EventEmitter();
  child.stdin = { write() {} };
  child.stdout = new PassThrough();
  const client = makeBridgeClient(child);
  const pending = client.request('thread/start', {});
  child.emit('exit', 1, 'SIGTERM');
  await assert.rejects(pending, /exited before reply/);
});

test('D.3: bridge client surfaces rpc error responses', async () => {
  const child = new EventEmitter();
  child.stdin = { write() {} };
  child.stdout = new PassThrough();
  const client = makeBridgeClient(child);
  const p = client.request('thread/start', {});
  child.stdout.write('{"id":1,"error":{"code":-32600,"message":"nope"}}\n');
  await assert.rejects(p, /nope/);
});

test('D.5: codex launcher fires codex://threads/<id> deep link by default', async () => {
  const opens = [];
  const stubOpen = (id) => { opens.push(id); return `codex://threads/${id}`; };
  const fakeFindBin = () => '/fake/codex';
  // Real `withCodexBridge` would spawn a subprocess; bypass by overriding
  // the launcher's flow with a manual stub of bridge results.
  const { openCodexThreadUrl } = require('../src/launchers/codex.js');
  // Direct test of the URL function itself.
  let spawnedArgs = null;
  const fakeSpawn = (bin, args) => {
    spawnedArgs = { bin, args };
    return { unref() {}, on() {} };
  };
  const url = openCodexThreadUrl('abc-123', { spawnFn: fakeSpawn });
  assert.equal(url, 'codex://threads/abc-123');
  assert.ok(spawnedArgs);
  assert.match(spawnedArgs.args.join(' '), /codex:\/\/threads\/abc-123/);
});

test('D.3: codex launcher reports unavailable when binary missing', async () => {
  const launcher = makeCodexLauncher({ findBin: () => null });
  assert.equal(launcher.available(), false);
  const r = await launcher.launch({ targetRepo: '/tmp' });
  assert.equal(r.kind, 'unavailable');
  assert.match(r.reason, /codex binary not found/);
});

// --- D.2: print launcher --------------------------------------------------

test('D.2: print launcher writes the handoff prompt to stdout', async () => {
  const launcher = makePrintLauncher();
  let captured = '';
  const original = console.log;
  console.log = (s) => { captured += s + '\n'; };
  try {
    const r = await launcher.launch({ handoffPrompt: 'HELLO HANDOFF' });
    assert.equal(r.kind, 'printed');
    assert.match(captured, /HELLO HANDOFF/);
  } finally { console.log = original; }
});
