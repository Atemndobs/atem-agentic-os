// Synthetic task identity for ambient tasks.
//
// A task id is `<provider>:<provider-session-id>`. The provider already
// minted a unique id for the session; ATEM reuses it instead of forcing
// the human to type `atem start` before any work begins.
//
// This module is pure: no FS, no process, no network. Used by detection
// (cli.js), the URL resolver (url.js), the handle farm (handles.js), and
// the materializer (Phase B).

// Providers whose synthetic ids ATEM produces. Adding a new one means:
//   1. Add to this set
//   2. Add a detector that returns `{ syntheticId, ... }`
//   3. Add a `resolveSynthetic` method on the adapter
const SYNTHETIC_PROVIDERS = new Set([
  'omp',
  'claude-code',
  'codex',
  'cursor',
  'opencode',
  'openrouter',
]);

// Regex for the synthetic id grammar. Provider prefix is `[a-z][a-z0-9-]*`,
// then `:`, then anything safe (no slashes, no whitespace, no NUL).
const SYNTHETIC_RE = /^([a-z][a-z0-9-]*):([A-Za-z0-9._:-]+)$/;

function isSyntheticId(value) {
  if (typeof value !== 'string') return false;
  const m = value.match(SYNTHETIC_RE);
  if (!m) return false;
  return SYNTHETIC_PROVIDERS.has(m[1]);
}

function parseSyntheticId(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(SYNTHETIC_RE);
  if (!m || !SYNTHETIC_PROVIDERS.has(m[1])) return null;
  return { provider: m[1], providerSessionId: m[2] };
}

function deriveSyntheticId(provider, providerSessionId) {
  if (!provider || !SYNTHETIC_PROVIDERS.has(provider)) {
    throw new Error(`Unknown synthetic provider: ${provider}`);
  }
  if (!providerSessionId) {
    throw new Error('providerSessionId is required');
  }
  // Sanitize: provider sessions may carry chars the URL/FS scheme dislikes.
  // We keep alphanumerics, `.`, `_`, `-`, and `:` (rare but legal). Anything
  // else becomes `-`. Drop trailing/leading dashes.
  const cleaned = String(providerSessionId)
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) {
    throw new Error(`providerSessionId sanitized to empty: ${providerSessionId}`);
  }
  return `${provider}:${cleaned}`;
}

// Display helper. Produces a stable short form like `omp:01HG`.
function shortId(syntheticId, n = 4) {
  const parsed = parseSyntheticId(syntheticId);
  if (!parsed) return syntheticId;
  const head = parsed.providerSessionId.slice(0, Math.max(1, n));
  return `${parsed.provider}:${head}`;
}

// Hash-based fallback id for providers (cursor, codex extension) that
// don't expose a real session id but do expose a cwd. Deterministic and
// reasonably collision-free.
function cwdFallbackId(provider, cwd) {
  if (!SYNTHETIC_PROVIDERS.has(provider)) {
    throw new Error(`Unknown synthetic provider: ${provider}`);
  }
  const path = require('node:path');
  const crypto = require('node:crypto');
  const resolved = path.resolve(cwd || '');
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 8);
  return `${provider}:cwd-${hash}`;
}

module.exports = {
  SYNTHETIC_PROVIDERS,
  SYNTHETIC_RE,
  isSyntheticId,
  parseSyntheticId,
  deriveSyntheticId,
  shortId,
  cwdFallbackId,
};
