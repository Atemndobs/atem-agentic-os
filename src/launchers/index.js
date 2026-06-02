// Launcher registry — per-provider strategies for "do the most useful
// thing when handing off to this destination."
//
// Each launcher implements:
//   name: string
//   available(): boolean        // sync — checks binary + env presence
//   launch(input): Promise<Result>
//
// where input is:
//   {
//     syntheticId,       // ATEM task id, e.g. "claude-code:0c6014"
//     fromProvider,      // "claude-code"
//     toProvider,        // "codex"
//     targetRepo,        // absolute path to repo or worktree
//     taskType,          // "implementation" etc.
//     handoffPrompt,     // the already-built ATEM prompt
//     paths,             // resolveActivePaths() bundle
//     agentsMdPath,      // path to AGENTS.md if written, else null
//     fromCli,           // boolean — true when invoked from `atem handoff`
//   }
//
// and Result is one of:
//   { kind: 'launched',    summary: string }
//   { kind: 'printed',     summary: string }
//   { kind: 'unavailable', reason: string }

const { makePrintLauncher } = require('./print.js');
const { makeCodexLauncher } = require('./codex.js');
const { makeClaudeCodeLauncher } = require('./claude-code.js');

const print = makePrintLauncher();

// Provider → launcher. Default to print for any provider not listed.
function defaultRegistry() {
  return {
    codex: makeCodexLauncher(),
    'claude-code': makeClaudeCodeLauncher(),
    // The rest fall through to print until they have their own launchers.
  };
}

function getLauncher(registry, providerName) {
  if (!providerName) return print;
  const candidate = registry[providerName];
  if (!candidate) return print;
  return candidate;
}

// Dispatch: pick the best launcher for the target provider, run it,
// fall back to print if it's unavailable.
async function dispatch(registry, input, { forcePrint = false } = {}) {
  if (forcePrint) {
    return print.launch(input);
  }
  const launcher = getLauncher(registry, input.toProvider);
  if (launcher === print) {
    return print.launch(input);
  }
  if (!launcher.available()) {
    const result = await print.launch(input);
    return {
      kind: 'printed',
      summary: `${launcher.name} launcher unavailable; printed prompt instead.`,
      fallback: { from: launcher.name, reason: 'unavailable' },
    };
  }
  try {
    const r = await launcher.launch(input);
    if (r.kind === 'unavailable') {
      const printed = await print.launch(input);
      return {
        kind: 'printed',
        summary: `${launcher.name} reported unavailable (${r.reason}); printed prompt instead.`,
        fallback: { from: launcher.name, reason: r.reason },
      };
    }
    return r;
  } catch (err) {
    const printed = await print.launch(input);
    return {
      kind: 'printed',
      summary: `${launcher.name} threw: ${err.message}; printed prompt instead.`,
      fallback: { from: launcher.name, error: err.message },
    };
  }
}

module.exports = {
  defaultRegistry,
  getLauncher,
  dispatch,
  print,
};
