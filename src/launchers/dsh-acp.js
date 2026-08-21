// Reusable ACP (Agent Client Protocol) session runner for DeepSeek Harness.
//
// Productionized from spikes/dsh-acp: boot dsh's ACP automation server over
// stdio, drive one session against a workspace, return the committed answer.
// Pure library: no process.exit, no argv parsing. The launcher and the
// detached runner both call runAcpSession().
//
// dsh ships the ACP SDK (`@agentclientprotocol/sdk`, protocol v1). We resolve
// it from the dsh install so the protocol version always matches the server.
// The SDK is ESM, so we load it with a dynamic import from this CJS module.
//
// Note (ACP contract): the server streams only committed assistant messages.
// Tool activity and reasoning stay off the wire by design, so toolCallCount
// is best-effort (usually 0 even when tools ran). For a real trajectory, read
// dsh's persisted session state under $DSH_HOME, not this stream.

const { spawn } = require('node:child_process');
const { Readable, Writable } = require('node:stream');
const { createRequire } = require('node:module');
const path = require('node:path');

function resolveAcpSdk(dshRepo) {
  const requireFromDsh = createRequire(path.join(dshRepo, 'package.json'));
  return requireFromDsh.resolve('@agentclientprotocol/sdk');
}

// Run one ACP session end to end. Resolves to:
//   { ok, stopReason, sessionId, text, toolCallCount, elapsedMs }
async function runAcpSession({
  dshRepo,
  configPath,
  workspace,
  seed,
  env = process.env,
  timeoutMs = 20 * 60 * 1000,
  onUpdate = null,
  spawnFn = spawn,
} = {}) {
  if (!dshRepo) throw new Error('runAcpSession: dshRepo is required');
  if (!configPath) throw new Error('runAcpSession: configPath is required');
  if (!workspace) throw new Error('runAcpSession: workspace is required');
  if (!seed || !String(seed).trim()) throw new Error('runAcpSession: seed is required');

  const sdkPath = resolveAcpSdk(dshRepo);
  const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = await import(sdkPath);

  const child = spawnFn(
    'node',
    ['--import', 'tsx', 'packages/examples/acp-demo/src/bin.ts', '--config', configPath],
    { cwd: dshRepo, stdio: ['pipe', 'pipe', 'pipe'], env },
  );
  if (child.stderr) child.stderr.on('data', () => { /* diagnostics; drop */ });

  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));

  const chunks = [];
  let toolCallCount = 0;
  const client = {
    async sessionUpdate({ update }) {
      const kind = update && update.sessionUpdate;
      if (kind === 'agent_message_chunk' && update.content && update.content.type === 'text') {
        chunks.push(update.content.text);
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        toolCallCount++;
      }
      if (onUpdate) { try { onUpdate(update); } catch { /* ignore */ } }
    },
    // Auto-approve sandbox escalations so an ATEM handoff runs unattended.
    async requestPermission(params) {
      const opts = (params && params.options) || [];
      const opt =
        opts.find((o) => o.kind === 'allow_once') ||
        opts.find((o) => o.kind === 'allow_always') ||
        opts[0];
      if (!opt) return { outcome: { outcome: 'cancelled' } };
      return { outcome: { outcome: 'selected', optionId: opt.optionId } };
    },
  };

  const conn = new ClientSideConnection(() => client, stream);
  const t0 = Date.now();
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`dsh ACP session timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    if (timer.unref) timer.unref();
  });

  try {
    const run = (async () => {
      await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const ns = await conn.newSession({ cwd: workspace, mcpServers: [] });
      const res = await conn.prompt({
        sessionId: ns.sessionId,
        prompt: [{ type: 'text', text: seed }],
      });
      return { sessionId: ns.sessionId, stopReason: res.stopReason };
    })();

    const out = await Promise.race([run, timeout]);
    return {
      ok: out.stopReason === 'end_turn',
      stopReason: out.stopReason,
      sessionId: out.sessionId,
      text: chunks.join(''),
      toolCallCount,
      elapsedMs: Date.now() - t0,
    };
  } finally {
    if (timer) clearTimeout(timer);
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

module.exports = { runAcpSession, resolveAcpSdk };
