#!/usr/bin/env node
// codex-runner — drives a single Codex bridge session to completion.
//
// Spawned detached by the codex launcher. Responsible for:
//   1. spawning `codex app-server --listen stdio://`
//   2. sending init + thread/start synchronously
//   3. writing one JSON line to OUR stdout so the parent can read
//      back the new thread id and disown us
//   4. continuing in the background: thread/name/set, turn/start
//   5. listening for `turn/completed` (or `turn/failed`) notification
//   6. cleanly killing the codex app-server child and exiting
//   7. a hard ceiling at MAX_LIFETIME_MS so we never linger forever
//
// Invocation: codex-runner.js <json-params-base64>
// Output (parent reads first line of stdout):
//   { "event": "ready", "threadId": "...", "threadPath": "..." }
//   or
//   { "event": "error", "message": "..." }

const { spawn } = require('node:child_process');

// Hard ceiling per bridge: a runaway model response gets cut off here.
// Configurable so users can extend for long-form handoffs.
// 3 min default covers the project-context handoffs (~50K-500K tokens).
const MAX_LIFETIME_MS = Number(process.env.ATEM_CODEX_RUNNER_MAX_MS) || 180_000;
const COMPLETION_GRACE_MS = 250;   // wait a beat after turn/completed so codex flushes the rollout

// Suppress EPIPE crashes when the parent has exited and our stdout pipe is
// closed but Node tries to write the next chunk.
process.stdout.on('error', () => { /* parent disowned */ });
process.stderr.on('error', () => { /* parent disowned */ });

// Optional self-trace for debugging the runner without parent-attached
// stderr. Enable by exporting ATEM_CODEX_RUNNER_LOG=/tmp/x.log.
const _logFile = process.env.ATEM_CODEX_RUNNER_LOG;
const _logFd = _logFile ? require('node:fs').openSync(_logFile, 'a') : null;
function trace(...parts) {
  if (!_logFd) return;
  try {
    require('node:fs').writeSync(_logFd, `[${Date.now()}] ${parts.join(' ')}\n`);
  } catch { /* harmless */ }
}

function fatal(message) {
  try {
    process.stdout.write(JSON.stringify({ event: 'error', message }) + '\n');
  } catch { /* parent gone */ }
  process.exit(1);
}

const rawArg = process.argv[2];
if (!rawArg) fatal('missing params');

let params;
try {
  params = JSON.parse(Buffer.from(rawArg, 'base64').toString('utf8'));
} catch (e) {
  fatal(`bad params: ${e.message}`);
}

const required = ['bin', 'cwd', 'sidebarName', 'devInstructions', 'firstTurn'];
for (const k of required) {
  if (!params[k]) fatal(`missing param: ${k}`);
}

const child = spawn(params.bin, ['app-server', '--listen', 'stdio://'], {
  stdio: ['pipe', 'pipe', 'ignore'],
  env: process.env,
});

let nextId = 1;
const pending = new Map();
let buffer = '';
let threadId = null;
let exiting = false;
let hardTimer = null;

function cleanShutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  if (hardTimer) clearTimeout(hardTimer);
  try { child.stdin.end(); } catch { /* harmless */ }
  // Give codex a beat to flush, then SIGTERM.
  setTimeout(() => {
    try { child.kill('SIGTERM'); } catch { /* harmless */ }
    setTimeout(() => process.exit(code), 50).unref();
  }, COMPLETION_GRACE_MS).unref();
}

child.on('exit', () => {
  if (!exiting) cleanShutdown(0);
});

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }

    if (msg.id !== undefined && pending.has(msg.id)) {
      const handlers = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) handlers.reject(new Error(msg.error.message || 'rpc error'));
      else handlers.resolve(msg.result);
      continue;
    }

    if (msg.method) trace('notif', msg.method);

    if (msg.method === 'turn/completed' || msg.method === 'turn/failed' || msg.method === 'thread/closed') {
      // Either way we're done. The turn either completed normally or
      // failed/closed — letting the bridge linger doesn't help.
      trace('cleanShutdown triggered by', msg.method);
      cleanShutdown(msg.method === 'turn/failed' ? 1 : 0);
      return;
    }
  }
});

function request(method, payload) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: payload }) + '\n');
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

async function run() {
  // Hard ceiling — fires whether or not we ever see turn/completed.
  hardTimer = setTimeout(() => cleanShutdown(0), MAX_LIFETIME_MS);

  await request('initialize', {
    clientInfo: { name: 'Codex Desktop', title: 'atem', version: '0.1.0' },
  });
  const startResult = await request('thread/start', {
    cwd: params.cwd,
    serviceName: params.sidebarName,
    developerInstructions: params.devInstructions,
    threadSource: 'user',
    sessionStartSource: 'startup',
    approvalPolicy: 'on-request',
  });
  threadId = startResult && startResult.thread && startResult.thread.id;
  if (!threadId) throw new Error('thread/start returned no id');

  // Signal the parent. After this single line the parent disowns us
  // and we're on our own.
  try {
    process.stdout.write(
      JSON.stringify({
        event: 'ready',
        threadId,
        threadPath: (startResult.thread && startResult.thread.path) || null,
      }) + '\n'
    );
  } catch { /* parent already gone */ }

  // Continue in the background. Failures here are non-fatal — the
  // thread is already on disk.
  try {
    await request('thread/name/set', { threadId, name: params.sidebarName });
  } catch { /* not fatal */ }

  try {
    await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: params.firstTurn }],
    });
  } catch (e) {
    // Failed to send turn/start. Shut down cleanly anyway so we
    // don't leak the codex app-server.
    cleanShutdown(1);
    return;
  }
  // Now we wait for turn/completed to arrive on the notification
  // channel (handled above), or for the hard timer to fire.
}

run().catch((e) => {
  try {
    process.stdout.write(JSON.stringify({ event: 'error', message: e.message }) + '\n');
  } catch { /* parent gone */ }
  cleanShutdown(1);
});
