// Claude Code launcher. Two flavors:
//   - If the synthetic id is claude-code:<uuid>, resume that exact
//     session via `claude --resume <uuid>` in the target cwd.
//   - Otherwise (cross-provider handoff), spawn fresh with
//     `claude -p "<first-turn>"` in the target cwd.
//
// `claude` binary must be on PATH. Detached spawn so the new process
// outlives ATEM's CLI exit.

const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');
const synthetic = require('../synthetic.js');

function whichClaude() {
  try {
    const out = execFileSync('which', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const trimmed = out.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

function makeClaudeCodeLauncher({ spawnFn = spawn, whichFn = whichClaude } = {}) {
  return {
    name: 'claude-code',

    available() {
      return !!whichFn();
    },

    async launch(input) {
      const bin = whichFn();
      if (!bin) return { kind: 'unavailable', reason: 'claude binary not on PATH' };
      if (!input.targetRepo || !fs.existsSync(input.targetRepo)) {
        return { kind: 'unavailable', reason: 'targetRepo does not exist' };
      }

      const firstTurn = `Pick up the ATEM handoff. Read \`atem://current/handoff\` first, then continue.`;

      // Resume mode when the synthetic id points at a claude-code session.
      const parsed = synthetic.parseSyntheticId(input.syntheticId);
      const args = (parsed && parsed.provider === 'claude-code')
        ? ['--resume', parsed.providerSessionId]
        : ['-p', firstTurn];

      // Detach so ATEM's CLI can exit while `claude` keeps running.
      const child = spawnFn(bin, args, {
        cwd: input.targetRepo,
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      try { child.unref(); } catch { /* harmless */ }

      const flavor = (parsed && parsed.provider === 'claude-code') ? 'resume' : 'fresh';
      return {
        kind: 'launched',
        summary: `claude-code ${flavor}: spawned \`claude ${args.join(' ')}\` in ${input.targetRepo} (pid ${child.pid || 'unknown'}).`,
      };
    },
  };
}

module.exports = { makeClaudeCodeLauncher, whichClaude };
