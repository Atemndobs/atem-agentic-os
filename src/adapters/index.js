// Provider adapter registry. Per-provider modules expose the same
// SessionAdapter API but stamp `provider` on writes for accountability.
// They do NOT execute work — providers do. Adapters only standardize
// how providers read and update ATEM session state.

const session = require('./session.js');
const omp = require('./omp.js');

function makeProviderAdapter(providerName, overrides = {}) {
  return {
    name: providerName,
    read: session.readSession,
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

module.exports = { session, adapters, get, omp };
