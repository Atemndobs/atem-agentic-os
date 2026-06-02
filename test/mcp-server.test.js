// F.2 — atem mcp-server tests.
// Covers protocol handshake, tools/list, tool calls (via a fake spawnFn
// when possible), error handling, and the stdio framing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const mcp = require('../src/mcp-server.js');

function call(method, params = {}, id = 1) {
  return mcp.handleRequest({ jsonrpc: '2.0', id, method, params });
}

test('F.2: initialize negotiates protocol + advertises tool capability', async () => {
  const reply = await call('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'test', version: '0' } });
  assert.equal(reply.jsonrpc, '2.0');
  assert.equal(reply.id, 1);
  assert.equal(reply.result.protocolVersion, '2025-03-26');
  assert.equal(reply.result.serverInfo.name, 'atem');
  assert.ok(reply.result.capabilities.tools);
});

test('F.2: tools/list returns every registered tool with schema', async () => {
  const reply = await call('tools/list');
  const names = reply.result.tools.map((t) => t.name).sort();
  assert.deepEqual(
    names,
    ['atem_adopt', 'atem_handoff', 'atem_ingest_omp', 'atem_resolve', 'atem_status']
  );
  for (const t of reply.result.tools) {
    assert.ok(t.description, `${t.name} should have a description`);
    assert.equal(t.inputSchema.type, 'object');
  }
});

test('F.2: handoff and status tools advertise their required args', async () => {
  const reply = await call('tools/list');
  const handoff = reply.result.tools.find((t) => t.name === 'atem_handoff');
  assert.deepEqual(handoff.inputSchema.required, ['task', 'to']);
  const status = reply.result.tools.find((t) => t.name === 'atem_status');
  // status is optional-args
  assert.ok(!status.inputSchema.required || status.inputSchema.required.length === 0);
});

test('F.2: unknown tool returns -32602', async () => {
  const reply = await call('tools/call', { name: 'atem_not_a_tool', arguments: {} });
  assert.ok(reply.error);
  assert.equal(reply.error.code, -32602);
});

test('F.2: unknown method returns -32601', async () => {
  const reply = await call('does/not/exist');
  assert.ok(reply.error);
  assert.equal(reply.error.code, -32601);
});

test('F.2: notifications/initialized is a true notification (no reply)', async () => {
  const reply = await call('notifications/initialized');
  assert.equal(reply, null);
});

test('F.2: ping returns empty result', async () => {
  const reply = await call('ping', {}, 7);
  assert.deepEqual(reply.result, {});
  assert.equal(reply.id, 7);
});

// --- end-to-end: spawn the server, talk to it over real stdio ----------

function spawnAtemMcp() {
  const bin = path.join(__dirname, '..', 'bin', 'atem.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atem-mcp-e2e-'));
  return spawn(process.execPath, [bin, 'mcp-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1', ATEM_HANDLES_DIR: path.join(home, '.atem', 'handles') },
    cwd: home, // outside any git repo so init defaults to global
  });
}

function rpc(child, msg) {
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(e);
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        if (parsed.id === msg.id) {
          child.stdout.off('data', onData);
          child.off('error', onError);
          resolve(parsed);
          return;
        }
      }
    };
    child.stdout.on('data', onData);
    child.on('error', onError);
    child.stdin.write(JSON.stringify(msg) + '\n');
    setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error(`timed out waiting for ${msg.method} response`));
    }, 10000);
  });
}

test('F.2 e2e: real stdio, real initialize + tools/list cycle', async () => {
  const child = spawnAtemMcp();
  try {
    const init = await rpc(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'test', version: '0' } } });
    assert.equal(init.result.serverInfo.name, 'atem');
    const list = await rpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(list.result.tools.length >= 5);
  } finally {
    child.stdin.end();
    try { child.kill(); } catch { /* harmless */ }
  }
});

test('F.2 e2e: tools/call atem_status returns text content', async () => {
  const child = spawnAtemMcp();
  try {
    await rpc(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', clientInfo: { name: 'test', version: '0' } } });
    const call = await rpc(child, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'atem_status', arguments: { all: true } },
    });
    assert.ok(call.result, 'expected a result');
    assert.ok(Array.isArray(call.result.content), 'expected content array');
    assert.equal(call.result.content[0].type, 'text');
    assert.match(call.result.content[0].text, /ATEM status/);
  } finally {
    child.stdin.end();
    try { child.kill(); } catch { /* harmless */ }
  }
});
