// ATEM MCP server — exposes ATEM's verbs as MCP tools so any
// MCP-supporting provider (Claude Code, Codex, Cursor, Cline,
// OpenCode) can drive ATEM uniformly.
//
// Wire format: JSON-RPC 2.0 over stdio, newline-delimited (Model
// Context Protocol, 2025-03-26 stable spec). No SDK; the protocol is
// small enough to implement directly.
//
// Tools exposed:
//   atem_handoff   — same as `atem handoff`
//   atem_status    — machine-wide + per-repo session detection
//   atem_resolve   — dereferences atem:// URLs
//   atem_adopt     — materialize a synthetic id, optionally alias it
//   atem_ingest_omp — pull omp state into an ATEM session

const fs = require('node:fs');

// Protocol version we speak. Clients may negotiate; we accept any
// future date string (Cursor sometimes sends a newer one) and reply
// with our own.
const PROTOCOL_VERSION = '2025-03-26';
const SERVER_NAME = 'atem';
const SERVER_VERSION = '0.1.0';

// ---- tool implementations -----------------------------------------------

// Lazy require so the server can introspect schemas without booting the
// whole CLI graph just to print tools/list.
let _cli = null;
function cli() {
  if (!_cli) _cli = require('./cli.js');
  return _cli;
}

const tools = {
  atem_handoff: {
    description:
      'Hand off the current ATEM task to a different provider. Materializes synthetic ids, writes AGENTS.md, and (when supported) creates a primed session in the destination.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'ATEM task id (e.g. claude-code:abc-123, TASK-001, or an alias).' },
        to: { type: 'string', description: 'Destination provider name (codex, claude-code, cursor, omp, …).' },
        repo: { type: 'string', description: 'Absolute path to the target repo or worktree.' },
        from: { type: 'string', description: 'Optional source provider to ingest state from (e.g. omp).' },
        print: { type: 'boolean', description: 'Print the handoff prompt to stdout instead of launching.' },
      },
      required: ['task', 'to'],
    },
    async run({ task, to, repo, from, print }) {
      const args = ['handoff', task, '--to', to];
      if (repo) args.push('--repo', repo);
      if (from) args.push('--from', from);
      if (print) args.push('--print');
      const out = await spawnAtem(args);
      return { content: [{ type: 'text', text: out }] };
    },
  },

  atem_status: {
    description: 'List detected provider activity and ambient ATEM sessions. Scope defaults to the cwd when in a git repo unless `all: true`.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Filter to this repo path.' },
        all: { type: 'boolean', description: 'Machine-wide; ignore auto-scope.' },
      },
    },
    async run({ repo, all }) {
      const args = ['status'];
      if (repo) args.push('--repo', repo);
      if (all) args.push('--all');
      const out = await spawnAtem(args);
      return { content: [{ type: 'text', text: out }] };
    },
  },

  atem_resolve: {
    description: 'Dereference an atem:// URL to a local file path (or to inline markdown for virtual artifacts like synthetic sessions).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'An atem:// URL (atem://current/state, atem://list, atem://<task>/handoff, …).' },
        raw: { type: 'boolean', description: 'Return the JSON envelope instead of the plain payload.' },
      },
      required: ['url'],
    },
    async run({ url, raw }) {
      const args = ['resolve', url];
      if (raw) args.push('--raw');
      const out = await spawnAtem(args);
      return { content: [{ type: 'text', text: out }] };
    },
  },

  atem_adopt: {
    description: 'Promote an ambient synthetic id into a materialized ATEM session, optionally aliased to a friendly name.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Synthetic id like claude-code:abc-123 or omp:01HX…' },
        name: { type: 'string', description: 'Human-friendly alias to register for this task.' },
        type: { type: 'string', description: 'Override the inferred task type (implementation, investigation, …).' },
        auto: { type: 'boolean', description: 'Materialize every detected ambient task in one call.' },
      },
    },
    async run({ task, name, type, auto }) {
      const args = ['adopt'];
      if (auto) {
        args.push('--auto');
      } else {
        if (!task) throw new Error('atem_adopt: pass `task` or set `auto: true`');
        args.push(task);
        if (name) args.push('--name', name);
        if (type) args.push('--type', type);
      }
      const out = await spawnAtem(args);
      return { content: [{ type: 'text', text: out }] };
    },
  },

  atem_ingest_omp: {
    description: 'Pull live omp state into an ATEM session.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'ATEM task id to ingest into.' },
        cwd: { type: 'string', description: 'omp working directory.' },
        session_id: { type: 'string', description: 'Specific omp session id.' },
        file: { type: 'string', description: 'Path to an omp session.jsonl.' },
      },
      required: ['task'],
    },
    async run({ task, cwd, session_id, file }) {
      const args = ['ingest-omp', task];
      if (cwd) args.push('--cwd', cwd);
      if (session_id) args.push('--session-id', session_id);
      if (file) args.push('--file', file);
      const out = await spawnAtem(args);
      return { content: [{ type: 'text', text: out }] };
    },
  },
};

// Spawn `atem <args>` as a child and capture stdout. Used to keep the
// MCP server thin — the actual logic lives in the CLI commands we
// already test.
function spawnAtem(args) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('node:child_process');
    const bin = process.argv[1]; // atem.js entry point
    const child = spawn(process.execPath, [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (c) => stdout.push(c));
    child.stderr.on('data', (c) => stderr.push(c));
    child.on('error', reject);
    child.on('exit', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        const msg = err.trim() || `atem ${args.join(' ')} exited ${code}`;
        reject(new Error(msg));
        return;
      }
      // Include stderr (handoff writes its AGENTS.md notice there) prefixed
      // so the model sees both streams without confusion.
      const combined = err ? `${out}\n--- stderr ---\n${err}` : out;
      resolve(combined);
    });
  });
}

// ---- protocol handler ---------------------------------------------------

function jsonRpcSuccess(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function toolListResponse() {
  return {
    tools: Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    // Negotiate protocol; accept whatever the client offered, advertise
    // our pinned version + tool capability.
    return jsonRpcSuccess(id, {
      protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: { listChanged: false } },
    });
  }
  if (method === 'notifications/initialized') {
    return null; // notification — no reply
  }
  if (method === 'tools/list') {
    return jsonRpcSuccess(id, toolListResponse());
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = tools[name];
    if (!tool) {
      return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
    }
    try {
      const result = await tool.run(args);
      return jsonRpcSuccess(id, result);
    } catch (e) {
      // Tool errors are returned in `result.isError` so the LLM sees
      // them (per MCP convention) — not as protocol-level errors.
      return jsonRpcSuccess(id, {
        isError: true,
        content: [{ type: 'text', text: e.message || String(e) }],
      });
    }
  }
  if (method === 'ping') {
    return jsonRpcSuccess(id, {});
  }
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

// ---- stdio driver -------------------------------------------------------

async function run({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  stdin.setEncoding('utf8');
  let buffer = '';

  function write(msg) {
    if (msg === null || msg === undefined) return;
    stdout.write(JSON.stringify(msg) + '\n');
  }

  stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let req;
      try { req = JSON.parse(line); }
      catch { write(jsonRpcError(null, -32700, 'Parse error')); continue; }
      handleRequest(req)
        .then((reply) => { if (reply) write(reply); })
        .catch((e) => {
          stderr.write(`[atem mcp] handler error: ${e.message}\n`);
          write(jsonRpcError(req && req.id, -32603, 'Internal error'));
        });
    }
  });

  return new Promise((resolve) => {
    stdin.on('end', resolve);
    stdin.on('close', resolve);
  });
}

module.exports = {
  run,
  handleRequest,
  tools,
  PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
};
