// Codex bridge launcher.
//
// Spawns `codex app-server --listen stdio://`, speaks newline-delimited
// JSON-RPC v2, and sends:
//   1. initialize           — handshake with clientInfo
//   2. thread/start         — create the thread, scoped to cwd
//   3. thread/name/set      — sidebar label
//   4. turn/start           — first user turn (the handoff prompt)
//
// The thread file lands in ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-...jsonl
// and shows up in Codex Desktop's sidebar.
//
// Bridge surface documented in docs/research/codex-bridge.md.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const DEFAULT_BIN_CANDIDATES = [
  '/Applications/Codex.app/Contents/Resources/codex',
];

function findCodexBinary() {
  // Mac app bundle path first (most likely to have remote-control + full
  // protocol surface; npm `codex-cli` lags behind).
  for (const candidate of DEFAULT_BIN_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const out = execFileSync('which', ['codex'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const trimmed = out.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

// --- Newline-delimited JSON-RPC over stdio ---------------------------------

function makeBridgeClient(child) {
  let nextId = 1;
  const pending = new Map();   // id -> { resolve, reject }
  let buffer = '';
  let closed = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && typeof msg.id !== 'undefined' && pending.has(msg.id)) {
        const handlers = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) handlers.reject(new Error(msg.error.message || 'rpc error'));
        else handlers.resolve(msg.result);
      }
      // Notifications (no id) are ignored for now.
    }
  });
  child.on('exit', () => {
    closed = true;
    for (const { reject } of pending.values()) {
      reject(new Error('codex app-server exited before reply'));
    }
    pending.clear();
  });

  function request(method, params) {
    if (closed) return Promise.reject(new Error('codex bridge already closed'));
    const id = nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { child.stdin.write(payload); }
      catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  }

  function close() {
    try { child.stdin.end(); } catch { /* harmless */ }
  }

  return { request, close };
}

// One-shot helper: spawn the app-server, run a sequence of calls, close.
async function withCodexBridge(bin, fn, { timeoutMs = 20000 } = {}) {
  const child = spawn(bin, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  const stderrChunks = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => stderrChunks.push(c));

  const client = makeBridgeClient(child);
  const timer = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch { /* harmless */ }
  }, timeoutMs);

  try {
    const result = await fn(client);
    return result;
  } finally {
    clearTimeout(timer);
    client.close();
    // Drain quickly; don't await forever.
    try { child.kill('SIGTERM'); } catch { /* harmless */ }
  }
}

// --- The launcher itself ----------------------------------------------------

// Fire the codex:// deep link so the running Desktop app jumps to the
// new thread (and re-indexes that project's threads). URL scheme
// discovered empirically from /Applications/Codex.app/Contents/Resources/app.asar
// (search for `codex://threads/`).
function openCodexThreadUrl(threadId, { spawnFn = spawn } = {}) {
  if (!threadId) return;
  const url = `codex://threads/${threadId}`;
  let bin = null, args = null;
  if (process.platform === 'darwin') {
    bin = 'open'; args = [url];
  } else if (process.platform === 'win32') {
    bin = 'cmd'; args = ['/c', 'start', '""', url];
  } else {
    bin = 'xdg-open'; args = [url];
  }
  try {
    const child = spawnFn(bin, args, { stdio: 'ignore', detached: true });
    try { child.unref(); } catch { /* harmless */ }
    return url;
  } catch {
    return null;
  }
}

function makeCodexLauncher({ findBin = findCodexBinary, openUrlFn = openCodexThreadUrl } = {}) {
  return {
    name: 'codex',

    available() {
      return !!findBin();
    },

    async launch(input) {
      const bin = findBin();
      if (!bin) return { kind: 'unavailable', reason: 'codex binary not found' };
      if (!input.targetRepo || !fs.existsSync(input.targetRepo)) {
        return { kind: 'unavailable', reason: 'targetRepo does not exist' };
      }

      const shortId = input.syntheticId || '(unknown)';
      const sidebarName = `atem: ${shortId}${input.fromProvider ? ` ← ${input.fromProvider}` : ''}`;
      const firstTurn = `Pick up the ATEM handoff. Read \`atem://current/handoff\` and \`atem://current/state\` first, then continue from where the previous provider left off.`;

      // The full handoff prompt becomes the thread's developer
      // instructions so the model carries it as system-side context.
      const devInstructions = [
        '# ATEM Session Contract',
        '',
        `You are continuing task \`${input.syntheticId}\` of type \`${input.taskType}\`.`,
        `Previous provider: \`${input.fromProvider}\`. Target repository: \`${input.targetRepo}\`.`,
        '',
        '## Required reading',
        '- `atem://current/brief`',
        '- `atem://current/state`',
        '- `atem://current/handoff`',
        '- `atem://current/decisions`',
        '- `atem://current/next`',
        '',
        '## Before stopping',
        'Update `handoff.md`, `state.md`, `next.md`, `log.md`, and `decisions.md` where relevant.',
        'Never end the session without updating `handoff.md`.',
      ].join('\n');

      let thread;
      let error;
      try {
        thread = await withCodexBridge(bin, async (client) => {
          await client.request('initialize', { clientInfo: { name: 'atem', version: '0.1.0' } });
          const startResult = await client.request('thread/start', {
            cwd: input.targetRepo,
            serviceName: sidebarName,
            developerInstructions: devInstructions,
            threadSource: 'subagent',
            sessionStartSource: 'startup',
            approvalPolicy: 'on-request',
          });
          const id = startResult && startResult.thread && startResult.thread.id;
          if (!id) throw new Error('thread/start returned no id');
          // Best-effort: name the thread for the sidebar (some Codex
          // versions key on `serviceName` already, but this is the
          // documented label setter).
          try {
            await client.request('thread/name/set', { threadId: id, name: sidebarName });
          } catch { /* not fatal */ }
          // Send the first turn as a text input.
          await client.request('turn/start', {
            threadId: id,
            input: [{ type: 'text', text: firstTurn }],
          });
          return {
            id,
            path: startResult.thread.path || null,
          };
        });
      } catch (e) {
        error = e;
      }

      if (error) {
        return { kind: 'unavailable', reason: `codex bridge failed: ${error.message}` };
      }

      // D.5: kick the running Codex Desktop to display the new thread.
      // Opt out with --no-focus (handled upstream by the caller passing
      // `focus: false`). Without this, Desktop's running app-server
      // doesn't poll session_index.jsonl immediately and the user
      // wouldn't see the thread until restart.
      let openedUrl = null;
      if (input.focus !== false) {
        openedUrl = openUrlFn(thread.id);
      }
      const focusBlurb = openedUrl ? ` Codex Desktop opened at the new thread.` : '';
      return {
        kind: 'launched',
        summary: `codex: created thread ${thread.id.slice(0, 8)}… (\`${sidebarName}\`).${focusBlurb}`,
        metadata: { threadId: thread.id, threadPath: thread.path, sidebarName, openedUrl },
      };
    },
  };
}

module.exports = { makeCodexLauncher, findCodexBinary, withCodexBridge, makeBridgeClient, openCodexThreadUrl };
