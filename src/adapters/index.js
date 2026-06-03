// Provider adapter registry. Per-provider modules expose the same
// SessionAdapter API but stamp `provider` on writes for accountability.
// They do NOT execute work — providers do. Adapters only standardize
// how providers read and update ATEM session state.

const fs = require('node:fs');
const crypto = require('node:crypto');
const session = require('./session.js');
const omp = require('./omp.js');
const claudeCode = require('./claude-code.js');
const cursor = require('./cursor.js');
const opencode = require('./opencode.js');
const url = require('../url.js');
const synthetic = require('../synthetic.js');

// URL-based read/write over atem:// paths. Lets any provider participate
// in ATEM through one path convention instead of N adapter-specific
// resolvers. Both methods take a `paths` bundle (from resolveActivePaths).

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function readUrl(atemUrl, paths) {
  const result = url.resolve(atemUrl, paths);
  if (result.kind === 'error') {
    const err = new Error(`atem:// read failed [${result.code}]: ${result.message}`);
    err.code = result.code;
    throw err;
  }
  if (result.kind === 'virtual') {
    return {
      kind: 'virtual',
      mimeType: result.mimeType,
      payload: result.payload,
    };
  }
  if (result.kind === 'directory') {
    return { kind: 'directory', localPath: result.localPath };
  }
  const content = fs.readFileSync(result.localPath, 'utf8');
  return {
    kind: 'file',
    localPath: result.localPath,
    mimeType: result.mimeType,
    content,
    hash: hashContent(content),
  };
}

function writeUrl(atemUrl, content, paths, opts = {}) {
  // Phase B: lazy materialization on writes to a synthetic id whose
  // session dir doesn't exist yet. Run before url.resolve so the
  // post-materialization resolve hits a real dir.
  const preParsed = url.parseUrl(atemUrl);
  if (preParsed) {
    let candidate = preParsed.target;
    if (candidate === 'current') {
      candidate = url.getActiveTaskId(paths) || candidate;
    } else {
      // Alias dereference for the materialization check too.
      const aliased = require('../aliases.js').resolveAlias(paths, candidate);
      if (aliased) candidate = aliased;
    }
    if (synthetic.isSyntheticId(candidate)) {
      const pathLib = require('node:path');
      const sessionDir = pathLib.join(paths.harnessDir, 'sessions', candidate);
      if (!fs.existsSync(sessionDir)) {
        const { materializeSyntheticTask } = require('../materialize.js');
        materializeSyntheticTask(candidate, paths, opts.materialize || {});
      }
    }
  }

  const result = url.resolve(atemUrl, paths);
  if (result.kind === 'error') {
    // Allow writes to artifacts whose file is allowed-but-missing.
    if (result.code !== 'missing-file') {
      const err = new Error(`atem:// write failed [${result.code}]: ${result.message}`);
      err.code = result.code;
      throw err;
    }
  }
  let localPath;
  if (result.kind === 'file' || result.kind === 'directory') {
    localPath = result.localPath;
  } else {
    // missing-file → infer the canonical path by re-running url.resolve on
    // the session-root and joining the alias. We require the URL to specify
    // a known artifact for this fallback.
    const parsed = url.parseUrl(atemUrl);
    if (!parsed || parsed.tail.length !== 1) {
      throw new Error(`atem:// write cannot create unknown artifact: ${atemUrl}`);
    }
    const alias = parsed.tail[0];
    const fname = url.ARTIFACT_ALIASES[alias];
    if (!fname) {
      throw new Error(`atem:// write to unknown artifact alias: ${alias}`);
    }
    let taskId = parsed.target === 'current' ? url.getActiveTaskId(paths) : parsed.target;
    const aliased = require('../aliases.js').resolveAlias(paths, taskId);
    if (aliased) taskId = aliased;
    if (!taskId) throw new Error('atem:// write: no active session');
    const pathLib = require('node:path');
    localPath = pathLib.join(paths.harnessDir, 'sessions', taskId, fname);
  }
  // Optional hash-anchored write: refuse if file changed since the caller
  // read it. omp-style integrity guard.
  if (opts.expectedHash && fs.existsSync(localPath)) {
    const current = hashContent(fs.readFileSync(localPath, 'utf8'));
    if (current !== opts.expectedHash) {
      const err = new Error(`atem:// stale write rejected at ${atemUrl} (file changed since read)`);
      err.code = 'stale-anchor';
      throw err;
    }
  }
  fs.mkdirSync(require('node:path').dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, content);
  return { localPath, hash: hashContent(content) };
}

function defaultResolveSynthetic(providerName) {
  return (syntheticId, artifact) => ({
    content: [
      `<!-- atem synthetic view of ${syntheticId} -->`,
      `<!-- read-only stub; ${providerName} adapter has no rich distiller yet -->`,
      '',
      `# ${artifact} — synthetic (${providerName})`,
      '',
      `This is a placeholder. The ${providerName} adapter does not yet`,
      `read its provider-side session file. Promote with`,
      `\`atem adopt ${syntheticId} --name <alias>\` to materialize an`,
      `editable ATEM session.`,
      '',
    ].join('\n'),
    mimeType: 'text/markdown',
  });
}

function makeProviderAdapter(providerName, overrides = {}) {
  return {
    name: providerName,
    read: session.readSession,
    resolveSynthetic: defaultResolveSynthetic(providerName),
    // url-based read/write — opt-in second signature. Callers pass a
    // paths bundle so the adapter stays stateless.
    readUrl(atemUrl, paths) { return readUrl(atemUrl, paths); },
    writeUrl(atemUrl, content, paths, opts) {
      return writeUrl(atemUrl, content, paths, opts);
    },
    update(taskId, patch = {}) {
      return session.updateSession(taskId, { ...patch, provider: providerName });
    },
    log(taskId, message) {
      return session.logEvent(taskId, `[${providerName}] ${message}`);
    },
    decision(taskId, payload) {
      return session.recordDecision(taskId, payload);
    },
    validation(taskId, payload) {
      return session.recordValidation(taskId, payload);
    },
    touched(taskId, files) {
      return session.markFilesTouched(taskId, files);
    },
    ...overrides,
  };
}

// --- Phase A: synthetic id rendering -------------------------------------
//
// Same shape for every provider whose adapter has a real distiller.
// The distilled view is provider-neutral (sessionId/cwd/firstTask/
// summary/etc), so one renderer serves all of them. Provider-specific
// flavor lives in the meta block (provider name + extras like "mode").

function renderSyntheticArtifact(provider, distilled, artifact, syntheticId) {
  const banner = [
    `<!-- atem synthetic view of ${syntheticId} -->`,
    `<!-- read-only; promote with \`atem adopt ${syntheticId} --name <alias>\` to materialize -->`,
    '',
  ].join('\n');
  const meta = [
    `- Provider: ${provider}`,
    `- Session: ${distilled.sessionId}`,
    `- cwd: ${distilled.cwd || '(unknown)'}`,
    distilled.title ? `- Title: ${distilled.title}` : '',
    distilled.model ? `- Model: ${distilled.model}` : '',
    distilled.mode && distilled.mode !== 'none' ? `- Mode: ${distilled.mode}` : '',
    distilled.pausedMidTool ? `- ⚠ Paused mid tool-call` : '',
  ].filter(Boolean).join('\n');

  switch (artifact) {
    case 'brief':
      return banner + `# Brief — synthetic\n\n${meta}\n\n## First task\n\n${distilled.firstTask || '(no captured task text)'}\n`;
    case 'state':
    case 'overview':
      return banner + `# State — synthetic\n\n${meta}\n\n## Summary\n\n${distilled.summary || '(no summary distilled)'}\n\n## Last user message\n\n${distilled.lastUserMessage || '(none)'}\n\n## Last assistant text\n\n${distilled.lastAssistantText || '(none)'}\n`;
    case 'handoff':
      return banner + `# Handoff — synthetic\n\n${meta}\n\n## Where ${provider} left off\n\n${distilled.summary || distilled.lastAssistantText || '(no progress captured)'}\n\n## Next provider should\n\nRead the brief and state above, then continue from "Where ${provider} left off".\n\n${distilled.pausedMidTool ? `⚠ ${provider} may be paused mid tool-call — verify before continuing.\n` : ''}`;
    case 'next':
      return banner + `# Next — synthetic\n\n(Synthetic task. Promote with \`atem adopt ${syntheticId}\` to materialize and edit.)\n`;
    case 'decisions':
      return banner + `# Decisions — synthetic\n\n` +
        (distilled.labels && distilled.labels.length
          ? distilled.labels.map((l) => `- [${l.timestamp || ''}] ${l.label}`).join('\n') + '\n'
          : '(no labels captured)\n');
    case 'validation':
      return banner + `# Validation — synthetic\n\n(synthetic; no validation captured)\n`;
    case 'log':
      return banner + `# Log — synthetic\n\n${provider} session started ${distilled.startedAt || '(unknown)'}.\n`;
    default:
      throw new Error(`unknown synthetic artifact for ${provider}: ${artifact}`);
  }
}

// Backwards-compatible alias for callers that imported the omp-specific name.
function renderOmpSyntheticArtifact(distilled, artifact, syntheticId) {
  return renderSyntheticArtifact('omp', distilled, artifact, syntheticId);
}

// omp adapter: same ATEM-side API as the others, but also exposes
// read-only helpers over omp's on-disk session files (T1.3).
// Distillation maps omp state into ATEM session files (T1.6).
const ompAdapter = makeProviderAdapter('omp', {
  external: {
    getAgentDir: omp.getAgentDir,
    getSessionsRoot: omp.getSessionsRoot,
    encodeSessionDirName: omp.encodeSessionDirName,
    findLatestSessionFile: omp.findLatestSessionFile,
    findSessionFileById: omp.findSessionFileById,
    readHeader: omp.readHeader,
    distill: omp.distillSessionSync,
    distillAsync: omp.distillSession,
  },
  // Phase A: render a synthetic markdown view of an omp session without
  // touching the ATEM session dir. The URL resolver calls this when
  // asked for atem://omp:<id>/<artifact> and the dir doesn't exist.
  resolveSynthetic(syntheticId, artifact) {
    const parsed = synthetic.parseSyntheticId(syntheticId);
    if (!parsed || parsed.provider !== 'omp') {
      throw new Error(`not an omp synthetic id: ${syntheticId}`);
    }
    let file = omp.findSessionFileById(parsed.providerSessionId);
    if (!file) throw new Error(`omp session not found on disk: ${parsed.providerSessionId}`);
    const distilled = omp.distillSessionSync(file);
    if (!distilled) throw new Error(`failed to distill ${file}`);
    return {
      content: renderSyntheticArtifact('omp', distilled, artifact, syntheticId),
      mimeType: 'text/markdown',
      metadata: { sessionFile: file, sessionId: distilled.sessionId },
    };
  },
  // Pull omp's current state into ATEM's session files. Read-only on
  // omp's side. taskOpts may specify { cwd } or { sessionFile } or
  // { sessionId } to choose which omp session to ingest.
  ingest(taskId, taskOpts = {}) {
    let file = taskOpts.sessionFile || null;
    if (!file && taskOpts.sessionId) file = omp.findSessionFileById(taskOpts.sessionId);
    if (!file && taskOpts.cwd) file = omp.findLatestSessionFile(taskOpts.cwd);
    if (!file) {
      throw new Error('omp.ingest: no session found (provide cwd, sessionId, or sessionFile)');
    }
    const d = omp.distillSessionSync(file);
    if (!d) throw new Error(`omp.ingest: failed to parse session at ${file}`);
    const summary = d.summary
      || d.lastAssistantText
      || (d.pausedMidTool ? 'omp paused mid tool-call' : 'omp session in progress');
    session.updateSession(taskId, {
      provider: 'omp',
      summary,
    });
    session.logEvent(taskId, `[omp] ingested session ${d.sessionId} from ${file}`);
    if (d.firstTask) {
      session.recordDecision(taskId, {
        decision: 'omp first-task captured',
        reason: d.firstTask,
        impact: d.model ? `model: ${d.model}, mode: ${d.mode}` : '',
      });
    }
    return d;
  },
});

// Claude Code adapter: same shape as omp. The distiller lives in
// src/adapters/claude-code.js and reads ~/.claude/projects/*/<id>.jsonl.
const claudeCodeAdapter = makeProviderAdapter('claude-code', {
  external: {
    getRootDir: claudeCode.getRootDir,
    getProjectsDir: claudeCode.getProjectsDir,
    encodeProjectDirName: claudeCode.encodeProjectDirName,
    findSessionFileById: claudeCode.findSessionFileById,
    findLatestSessionFile: claudeCode.findLatestSessionFile,
    distill: claudeCode.distillSessionSync,
  },
  resolveSynthetic(syntheticId, artifact) {
    const parsed = synthetic.parseSyntheticId(syntheticId);
    if (!parsed || parsed.provider !== 'claude-code') {
      throw new Error(`not a claude-code synthetic id: ${syntheticId}`);
    }
    const file = claudeCode.findSessionFileById(parsed.providerSessionId);
    if (!file) throw new Error(`claude-code transcript not found for ${parsed.providerSessionId}`);
    const distilled = claudeCode.distillSessionSync(file);
    if (!distilled) throw new Error(`failed to distill ${file}`);
    return {
      content: renderSyntheticArtifact('claude-code', distilled, artifact, syntheticId),
      mimeType: 'text/markdown',
      metadata: { sessionFile: file, sessionId: distilled.sessionId },
    };
  },
  ingest(taskId, taskOpts = {}) {
    let file = taskOpts.sessionFile || null;
    if (!file && taskOpts.sessionId) file = claudeCode.findSessionFileById(taskOpts.sessionId);
    if (!file && taskOpts.cwd) file = claudeCode.findLatestSessionFile(taskOpts.cwd);
    if (!file) {
      throw new Error('claude-code.ingest: no session found (provide cwd, sessionId, or sessionFile)');
    }
    const d = claudeCode.distillSessionSync(file);
    if (!d) throw new Error(`claude-code.ingest: failed to parse ${file}`);
    const summary = d.summary
      || d.lastAssistantText
      || (d.pausedMidTool ? 'claude-code paused mid tool-call' : 'claude-code session in progress');
    session.updateSession(taskId, { provider: 'claude-code', summary });
    session.logEvent(taskId, `[claude-code] ingested session ${d.sessionId} from ${file}`);
    if (d.firstTask) {
      session.recordDecision(taskId, {
        decision: 'claude-code first-task captured',
        reason: d.firstTask,
        impact: d.model ? `model: ${d.model}, mode: ${d.mode}` : '',
      });
    }
    return d;
  },
});

// Cursor adapter: same shape as claude-code. Reads the per-workspace
// composer index (workspaceStorage/<md5>/state.vscdb) and the global
// content store (globalStorage/state.vscdb). See
// docs/research/cursor-session-layout.md.
const cursorAdapter = makeProviderAdapter('cursor', {
  external: {
    getRootDir: cursor.getRootDir,
    getGlobalDbPath: cursor.getGlobalDbPath,
    listWorkspacesForCwd: cursor.listWorkspacesForCwd,
    listComposersForCwd: cursor.listComposersForCwd,
    findLatestComposerForCwd: cursor.findLatestComposerForCwd,
    findSessionFileById: cursor.findSessionFileById,
    findLatestSessionFile: cursor.findLatestSessionFile,
    distill: cursor.distillSessionSync,
    distillLatestForCwd: cursor.distillLatestForCwd,
  },
  resolveSynthetic(syntheticId, artifact) {
    const parsed = synthetic.parseSyntheticId(syntheticId);
    if (!parsed || parsed.provider !== 'cursor') {
      throw new Error(`not a cursor synthetic id: ${syntheticId}`);
    }
    const dbPath = cursor.findSessionFileById(parsed.providerSessionId);
    if (!dbPath) throw new Error(`cursor composer not found for ${parsed.providerSessionId}`);
    const distilled = cursor.distillSessionSync(parsed.providerSessionId);
    if (!distilled) throw new Error(`failed to distill cursor composer ${parsed.providerSessionId}`);
    return {
      content: renderSyntheticArtifact('cursor', distilled, artifact, syntheticId),
      mimeType: 'text/markdown',
      metadata: { sessionFile: dbPath, sessionId: distilled.sessionId },
    };
  },
  ingest(taskId, taskOpts = {}) {
    let composerId = taskOpts.sessionId || null;
    if (!composerId && taskOpts.cwd) {
      const latest = cursor.findLatestComposerForCwd(taskOpts.cwd);
      if (latest) composerId = latest.composerId;
    }
    if (!composerId) {
      throw new Error('cursor.ingest: no composer found (provide sessionId or cwd)');
    }
    const d = cursor.distillSessionSync(composerId, { cwd: taskOpts.cwd || '' });
    if (!d) throw new Error(`cursor.ingest: failed to distill ${composerId}`);
    const summary = d.summary
      || d.lastAssistantText
      || (d.pausedMidTool ? 'cursor paused mid tool-call' : 'cursor session in progress');
    session.updateSession(taskId, { provider: 'cursor', summary });
    session.logEvent(taskId, `[cursor] ingested composer ${d.sessionId}`);
    if (d.firstTask) {
      session.recordDecision(taskId, {
        decision: 'cursor first-task captured',
        reason: d.firstTask,
        impact: d.mode ? `mode: ${d.mode}` : '',
      });
    }
    return d;
  },
});

// OpenCode adapter: SQLite-backed, cleanest of all. See
// docs/research/opencode-session-layout.md.
const opencodeAdapter = makeProviderAdapter('opencode', {
  external: {
    getDbPath: opencode.getDbPath,
    listSessionsForCwd: opencode.listSessionsForCwd,
    findLatestSessionForCwd: opencode.findLatestSessionForCwd,
    findSessionFileById: opencode.findSessionFileById,
    findLatestSessionFile: opencode.findLatestSessionFile,
    distill: opencode.distillSessionSync,
    distillLatestForCwd: opencode.distillLatestForCwd,
  },
  resolveSynthetic(syntheticId, artifact) {
    const parsed = synthetic.parseSyntheticId(syntheticId);
    if (!parsed || parsed.provider !== 'opencode') {
      throw new Error(`not an opencode synthetic id: ${syntheticId}`);
    }
    if (!opencode.findSessionFileById(parsed.providerSessionId)) {
      throw new Error(`opencode session not found for ${parsed.providerSessionId}`);
    }
    const distilled = opencode.distillSessionSync(parsed.providerSessionId);
    if (!distilled) throw new Error(`failed to distill opencode session ${parsed.providerSessionId}`);
    return {
      content: renderSyntheticArtifact('opencode', distilled, artifact, syntheticId),
      mimeType: 'text/markdown',
      metadata: { sessionFile: opencode.getDbPath(), sessionId: distilled.sessionId },
    };
  },
  ingest(taskId, taskOpts = {}) {
    let sessionId = taskOpts.sessionId || null;
    if (!sessionId && taskOpts.cwd) {
      const latest = opencode.findLatestSessionForCwd(taskOpts.cwd);
      if (latest) sessionId = latest.id;
    }
    if (!sessionId) {
      throw new Error('opencode.ingest: no session found (provide sessionId or cwd)');
    }
    const d = opencode.distillSessionSync(sessionId, { cwd: taskOpts.cwd });
    if (!d) throw new Error(`opencode.ingest: failed to distill ${sessionId}`);
    const summary = d.summary
      || d.lastAssistantText
      || (d.pausedMidTool ? 'opencode paused mid tool-call' : 'opencode session in progress');
    session.updateSession(taskId, { provider: 'opencode', summary });
    session.logEvent(taskId, `[opencode] ingested session ${d.sessionId}`);
    if (d.firstTask) {
      session.recordDecision(taskId, {
        decision: 'opencode first-task captured',
        reason: d.firstTask,
        impact: d.model ? `model: ${d.model}, mode: ${d.mode}` : '',
      });
    }
    return d;
  },
});

const adapters = {
  'claude-code': claudeCodeAdapter,
  codex: makeProviderAdapter('codex'),
  cursor: cursorAdapter,
  opencode: opencodeAdapter,
  openrouter: makeProviderAdapter('openrouter'),
  omp: ompAdapter,
  'local-model': makeProviderAdapter('local-model'),
  manual: makeProviderAdapter('manual'),
};

function get(providerName) {
  const a = adapters[providerName];
  if (!a) throw new Error(`Unknown provider: ${providerName}`);
  return a;
}

module.exports = { session, adapters, get, omp, claudeCode, cursor, opencode, url, readUrl, writeUrl, hashContent };
