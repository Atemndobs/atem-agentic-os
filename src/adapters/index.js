// Provider adapter registry. Per-provider modules expose the same
// SessionAdapter API but stamp `provider` on writes for accountability.
// They do NOT execute work — providers do. Adapters only standardize
// how providers read and update ATEM session state.

const fs = require('node:fs');
const crypto = require('node:crypto');
const session = require('./session.js');
const omp = require('./omp.js');
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
    const taskId = parsed.target === 'current' ? url.getActiveTaskId(paths) : parsed.target;
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

function renderOmpSyntheticArtifact(distilled, artifact, syntheticId) {
  const banner = [
    `<!-- atem synthetic view of ${syntheticId} -->`,
    `<!-- read-only; promote with \`atem adopt ${syntheticId} --name <alias>\` to materialize -->`,
    '',
  ].join('\n');
  const meta = [
    `- Provider: omp`,
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
      return banner + `# Handoff — synthetic\n\n${meta}\n\n## Where omp left off\n\n${distilled.summary || distilled.lastAssistantText || '(no progress captured)'}\n\n## Next provider should\n\nRead the brief and state above, then continue from "Where omp left off".\n\n${distilled.pausedMidTool ? '⚠ omp may be paused mid tool-call — verify before continuing.\n' : ''}`;
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
      return banner + `# Log — synthetic\n\nomp session started ${distilled.startedAt || '(unknown)'}.\n`;
    default:
      throw new Error(`unknown synthetic artifact for omp: ${artifact}`);
  }
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
      content: renderOmpSyntheticArtifact(distilled, artifact, syntheticId),
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

const adapters = {
  'claude-code': makeProviderAdapter('claude-code'),
  codex: makeProviderAdapter('codex'),
  cursor: makeProviderAdapter('cursor'),
  opencode: makeProviderAdapter('opencode'),
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

module.exports = { session, adapters, get, omp, url, readUrl, writeUrl, hashContent };
