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
  const notifWaiters = [];     // [{ matcher, resolve }]
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
      } else if (msg && msg.method && notifWaiters.length > 0) {
        // Fire any matching notification waiters and drop them.
        for (let i = notifWaiters.length - 1; i >= 0; i--) {
          if (notifWaiters[i].matcher(msg)) {
            const w = notifWaiters.splice(i, 1)[0];
            w.resolve(msg);
          }
        }
      }
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

  // Wait for a server notification matching the predicate, with a
  // timeout. Used to confirm the user message has been persisted
  // before we tear the bridge down — otherwise the threads row's
  // first_user_message stays empty and Codex Desktop hides it.
  function waitForNotification(matcher, { timeoutMs = 4000 } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const onResolve = (msg) => { if (done) return; done = true; resolve(msg); };
      notifWaiters.push({ matcher, resolve: onResolve });
      setTimeout(() => onResolve(null), timeoutMs);
    });
  }

  return { request, close, waitForNotification };
}

// Spawn codex-runner.js as a detached child, wait for its single
// "ready" event line, then disown it. The runner owns the codex
// app-server child's lifecycle and self-terminates after turn/completed
// (or a hard 2-minute ceiling), so no orphan `codex app-server`
// processes linger after the model response finishes.
function runCodexBridgeRunner(params) {
  const runnerScript = path.join(__dirname, 'codex-runner.js');
  return new Promise((resolve, reject) => {
    const argBlob = Buffer.from(JSON.stringify(params)).toString('base64');
    const child = spawn(process.execPath, [runnerScript, argBlob], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
      env: process.env,
    });
    let buffer = '';
    let resolved = false;
    const onChunk = (chunk) => {
      buffer += chunk.toString('utf8');
      const i = buffer.indexOf('\n');
      if (i < 0) return;
      const firstLine = buffer.slice(0, i);
      let msg;
      try { msg = JSON.parse(firstLine); } catch { /* keep reading */ return; }
      resolved = true;
      child.stdout.off('data', onChunk);
      // Disown the runner. It continues processing the turn in the
      // background and self-terminates when done. We exit immediately.
      try { child.unref(); } catch { /* harmless */ }
      try { child.stdout.unref && child.stdout.unref(); } catch { /* harmless */ }
      if (msg.event === 'ready') {
        resolve({ id: msg.threadId, path: msg.threadPath });
      } else {
        reject(new Error(msg.message || 'codex-runner failed before ready'));
      }
    };
    child.stdout.on('data', onChunk);
    child.on('error', (e) => { if (!resolved) reject(e); });
    child.on('exit', (code) => {
      if (resolved) return;
      reject(new Error(`codex-runner exited (code ${code}) before ready`));
    });
    // Safety: if the runner never emits ready within 20s, give up.
    setTimeout(() => {
      if (resolved) return;
      try { child.kill('SIGTERM'); } catch { /* harmless */ }
      reject(new Error('codex-runner timed out before ready'));
    }, 20_000).unref();
  });
}

// One-shot helper: spawn the app-server, run a sequence of calls, close.
//
// `keepRunning: true` returns instead of killing the child, so the caller
// can detach and let the turn/start finish in the background. This is how
// we keep `atem handoff` fast (~3s) while still producing a real model
// response so Codex Desktop's sidebar lists the thread.
async function withCodexBridge(bin, fn, { timeoutMs = 20000, keepRunning = false } = {}) {
  const child = spawn(bin, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    detached: keepRunning,
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
    if (!keepRunning) {
      client.close();
      try { child.kill('SIGTERM'); } catch { /* harmless */ }
    } else {
      // Detach the child so it survives our process exit.
      try { child.unref(); } catch { /* harmless */ }
    }
  }
}

// --- The launcher itself ----------------------------------------------------

// Populate the `first_user_message` + `preview` columns on the threads
// row so Codex Desktop's sidebar shows the thread. Discovered by
// diffing visible vs invisible rows: the sidebar filter is "thread has
// a first user message". Without this update, the row exists but the
// project sidebar hides it. Codex Desktop will overwrite these
// columns naturally when the user opens the thread and interacts with
// the model — our write is just a placeholder so the sidebar renders.
//
// Best-effort. Skips silently if sqlite3 isn't available or the schema
// has changed.
function setFirstUserMessage(threadId, message, { homeDir } = {}) {
  if (!threadId || !message) return false;
  const home = homeDir || os.homedir();
  const dbFile = path.join(home, '.codex', 'state_5.sqlite');
  if (!fs.existsSync(dbFile)) return false;
  const escaped = String(message).replace(/'/g, "''").slice(0, 600);
  const sql = `UPDATE threads
                 SET first_user_message = '${escaped}',
                     preview = '${escaped}'
                 WHERE id = '${threadId}'
                   AND (first_user_message IS NULL OR first_user_message = '');`;
  try {
    execFileSync('sqlite3', [dbFile, sql], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// Register the new thread in Codex Desktop's sidebar cache so it
// appears in the project's chat list. Discovered empirically:
//   ~/.codex/.codex-global-state.json
//     thread-workspace-root-hints: { <threadId>: <cwd>, ... }
// without this hint, the Desktop hides the thread from the project's
// sidebar even when it's present in session_index.jsonl.
//
// Note: Codex Desktop deliberately groups threads under the parent git
// repo's project (by git common ancestor), so a thread opened in a
// worktree appears under the main repo's sidebar entry, not under the
// worktree path. We do NOT try to register the worktree as a separate
// workspace root — Codex owns `electron-saved-workspace-roots` and
// `project-order` in memory and will overwrite any external write on
// its next flush. The thread title + git_branch are the disambiguator.
//
// Best-effort. If the file is missing or unparseable, silently skip —
// the thread is still created and addressable by URL.
function registerThreadInDesktopCache(threadId, cwd, { homeDir } = {}) {
  if (!threadId || !cwd) return false;
  const home = homeDir || os.homedir();
  const stateFile = path.join(home, '.codex', '.codex-global-state.json');
  if (!fs.existsSync(stateFile)) return false;
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch { return false; }
  if (!state || typeof state !== 'object') return false;
  if (!state['thread-workspace-root-hints'] || typeof state['thread-workspace-root-hints'] !== 'object') {
    state['thread-workspace-root-hints'] = {};
  }
  if (state['thread-workspace-root-hints'][threadId] === cwd) return true;
  state['thread-workspace-root-hints'][threadId] = cwd;
  const tmp = stateFile + '.atem-tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, stateFile);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* harmless */ }
    return false;
  }
}

// Build the human-scannable sidebar title for a handoff thread.
//
// Codex Desktop groups threads under the parent git repo's project, so
// the title is the only disambiguator when several handoffs target
// different branches/worktrees of the same repo. Format:
//
//   atem · <branch> · <short-id> ← <fromProvider>
//
// Branch is read from `git -C <targetRepo> rev-parse --abbrev-ref HEAD`
// best-effort; omitted on failure. Short-id is the last 8 chars of the
// UUID-shaped tail of syntheticId (e.g. claude-code:1bdfa3c6-…-952 →
// `…8deddc952`), or the trimmed syntheticId itself if it doesn't look
// like a UUID. Falls back to the v0.1 format on any error so existing
// behaviour is preserved.
function buildSidebarName({ syntheticId, fromProvider, targetRepo }) {
  try {
    const id = String(syntheticId || '(unknown)');
    const uuidMatch = id.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-([0-9a-f]{12})/i);
    const shortTail = uuidMatch ? uuidMatch[1].slice(-8) : id.slice(-12);
    let branch = null;
    if (targetRepo) {
      try {
        branch = execFileSync('git', ['-C', targetRepo, 'rev-parse', '--abbrev-ref', 'HEAD'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || null;
        if (branch === 'HEAD') branch = null; // detached
      } catch { /* not a git repo / git unavailable */ }
    }
    const parts = ['atem'];
    if (branch) parts.push(branch);
    parts.push(shortTail);
    const head = parts.join(' · ');
    return fromProvider ? `${head} ← ${fromProvider}` : head;
  } catch {
    return `atem: ${syntheticId || '(unknown)'}${fromProvider ? ` ← ${fromProvider}` : ''}`;
  }
}

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

function makeCodexLauncher({
  findBin = findCodexBinary,
  openUrlFn = openCodexThreadUrl,
  registerInDesktopFn = registerThreadInDesktopCache,
  setFirstMessageFn = setFirstUserMessage,
} = {}) {
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
      const sidebarName = buildSidebarName({
        syntheticId: shortId,
        fromProvider: input.fromProvider,
        targetRepo: input.targetRepo,
      });
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
        if (input.noRespond) {
          // --no-respond: create the thread synchronously and exit.
          // No detached runner, no background turn, no model tokens
          // spent. Sidebar visibility comes solely from the SQLite
          // write below. The thread won't have a model response
          // until the user opens it and types — that's the trade.
          thread = await withCodexBridge(bin, async (client) => {
            await client.request('initialize', {
              clientInfo: { name: 'Codex Desktop', title: 'atem', version: '0.1.0' },
            });
            const startResult = await client.request('thread/start', {
              cwd: input.targetRepo,
              serviceName: sidebarName,
              developerInstructions: devInstructions,
              threadSource: 'user',
              sessionStartSource: 'startup',
              approvalPolicy: 'on-request',
            });
            const id = startResult && startResult.thread && startResult.thread.id;
            if (!id) throw new Error('thread/start returned no id');
            try { await client.request('thread/name/set', { threadId: id, name: sidebarName }); } catch { /* not fatal */ }
            return { id, path: startResult.thread.path || null };
          });
        } else {
          // Default: drive the full thread/start + turn/start through
          // the runner script. The runner self-terminates after
          // turn/completed, so no orphan codex app-server processes.
          thread = await runCodexBridgeRunner({
            bin,
            cwd: input.targetRepo,
            sidebarName,
            devInstructions,
            firstTurn,
          });
        }
      } catch (e) {
        error = e;
      }

      if (error) {
        return { kind: 'unavailable', reason: `codex bridge failed: ${error.message}` };
      }

      // D.6: register the thread in Codex Desktop's sidebar cache.
      // Without this, the thread is created and addressable by URL but
      // doesn't show up in the project's chat list.
      const cached = registerInDesktopFn(thread.id, input.targetRepo);

      // D.7: populate first_user_message in the threads SQLite row so
      // the project sidebar will actually render this thread. Codex
      // hides empty threads. The model never actually responds to our
      // seed turn (we exit before that), so the column would otherwise
      // stay empty. Use the full handoff prompt so Codex's
      // auto-summarizer has something rich to work with — the thread
      // title and preview that appear in the sidebar come from
      // summarizing this message.
      const sidebarRow = setFirstMessageFn(thread.id, input.handoffPrompt || `Pick up the ATEM handoff. Read \`atem://current/handoff\` first.`);

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
      const cacheBlurb = (cached || sidebarRow) ? '' : ' (sidebar registration skipped — Codex may need a restart to display this thread).';
      const respondBlurb = input.noRespond ? ' (no-respond: model won\'t run until you open the thread).' : '';
      return {
        kind: 'launched',
        summary: `codex: created thread ${thread.id.slice(0, 8)}… (\`${sidebarName}\`).${focusBlurb}${cacheBlurb}${respondBlurb}`,
        metadata: { threadId: thread.id, threadPath: thread.path, sidebarName, openedUrl, sidebarRegistered: cached, sqliteRow: sidebarRow, noRespond: !!input.noRespond },
      };
    },
  };
}

module.exports = {
  makeCodexLauncher,
  findCodexBinary,
  withCodexBridge,
  makeBridgeClient,
  openCodexThreadUrl,
  registerThreadInDesktopCache,
  setFirstUserMessage,
  runCodexBridgeRunner,
  buildSidebarName,
};
