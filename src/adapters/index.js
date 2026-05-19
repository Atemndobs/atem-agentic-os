// Provider adapter registry. Per-provider modules expose the same
// SessionAdapter API but stamp `provider` on writes for accountability.
// They do NOT execute work — providers do. Adapters only standardize
// how providers read and update ATEM session state.

const session = require('./session.js');

function makeProviderAdapter(providerName) {
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
  };
}

const adapters = {
  'claude-code': makeProviderAdapter('claude-code'),
  codex: makeProviderAdapter('codex'),
  cursor: makeProviderAdapter('cursor'),
  opencode: makeProviderAdapter('opencode'),
  openrouter: makeProviderAdapter('openrouter'),
  'local-model': makeProviderAdapter('local-model'),
  manual: makeProviderAdapter('manual'),
};

function get(providerName) {
  const a = adapters[providerName];
  if (!a) throw new Error(`Unknown provider: ${providerName}`);
  return a;
}

module.exports = { session, adapters, get };
