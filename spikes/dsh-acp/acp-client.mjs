// Spike: can ATEM drive DeepSeek Harness over ACP (Agent Client Protocol)?
//
// This is a stand-in for what a future src/launchers/dsh.js (ACP variant)
// would do: spawn dsh's ACP automation server over stdio, initialize, open a
// session pointed at a workspace, send a seed prompt, and collect the
// committed assistant text. Backed by local Ollama (no paid keys).
//
// Usage (from anywhere):
//   node spikes/dsh-acp/acp-client.mjs [workspace] ["seed prompt"]
//
// It resolves the ACP SDK and the server bin from the dsh repo, so it must
// point DSH at a real deepseek-harness checkout.

import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const DSH = process.env.DSH_REPO || '/Users/atem/sites/deepseek-harness'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG = path.join(HERE, 'cordis.ollama.yml')
const workspace = process.argv[2] || DSH
const seed =
  process.argv[3] ||
  'List the package directories directly under packages/. Answer with just the directory names, very briefly.'

// Resolve the ACP SDK from the dsh install so protocol versions match exactly.
const requireFromDsh = createRequire(path.join(DSH, 'package.json'))
const sdkPath = requireFromDsh.resolve('@agentclientprotocol/sdk')
const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = await import(sdkPath)

console.error(`[spike] dsh repo:  ${DSH}`)
console.error(`[spike] config:    ${CONFIG}`)
console.error(`[spike] workspace: ${workspace}`)
console.error(`[spike] ACP SDK:   ${sdkPath} (protocol v${PROTOCOL_VERSION})`)

// Boot dsh's ACP automation server. stdout carries pure ACP JSON-RPC; stderr
// is diagnostics, which we pass through so we can watch the harness boot.
const child = spawn(
  'node',
  ['--import', 'tsx', 'packages/examples/acp-demo/src/bin.ts', '--config', CONFIG],
  { cwd: DSH, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env } },
)
child.on('exit', (code, sig) => console.error(`[spike] server exited code=${code} sig=${sig}`))

const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))

const chunks = []
const toolCalls = []
const client = {
  async sessionUpdate({ update }) {
    const kind = update?.sessionUpdate
    if (kind === 'agent_message_chunk' && update.content?.type === 'text') {
      chunks.push(update.content.text)
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      const title = update.title || update.rawInput?.command || update.toolCallId || ''
      toolCalls.push(`${kind}: ${JSON.stringify(title).slice(0, 100)}`)
      console.error(`[update] ${kind} ${JSON.stringify(title).slice(0, 100)}`)
    } else {
      console.error(`[update] ${kind}`)
    }
  },
  // Auto-approve any sandbox-escalation request so the run is non-interactive,
  // which is exactly what an ATEM automated handoff needs.
  async requestPermission(params) {
    const opt =
      params.options?.find((o) => o.kind === 'allow_once') ||
      params.options?.find((o) => o.kind === 'allow_always') ||
      params.options?.[0]
    console.error(`[permission] auto-selecting ${opt?.optionId} (${opt?.kind})`)
    return { outcome: { outcome: 'selected', optionId: opt.optionId } }
  },
}

const conn = new ClientSideConnection(() => client, stream)

try {
  const init = await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  })
  console.error(`[initialize] ok: ${JSON.stringify(init)}`)

  const ns = await conn.newSession({ cwd: workspace, mcpServers: [] })
  console.error(`[session/new] sessionId=${ns.sessionId}`)

  const t0 = Date.now()
  const res = await conn.prompt({
    sessionId: ns.sessionId,
    prompt: [{ type: 'text', text: seed }],
  })
  const ms = Date.now() - t0
  console.error(`[session/prompt] stopReason=${res.stopReason} elapsedMs=${ms} toolCalls=${toolCalls.length}`)

  console.log('\n===== COMMITTED ASSISTANT TEXT =====')
  console.log(chunks.join('') || '(no committed text)')
  console.log('===== END =====')
  process.exitCode = res.stopReason === 'end_turn' ? 0 : 2
} catch (err) {
  console.error('[spike] ERROR:', err?.stack || err)
  process.exitCode = 1
} finally {
  try { child.kill('SIGTERM') } catch {}
}
