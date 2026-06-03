// OpenCode launcher.
//
// OpenCode honors AGENTS.md natively (verified by ripping the binary).
// `commandHandoff` already writes AGENTS.md when handing off to
// opencode (alongside codex + omp), so the launcher's job is just:
//
//   1. Spawn a real opencode session via `opencode run` so the user
//      sees a named, primed entry in `opencode session list` and in
//      the TUI sidebar — this is the Cursor "Path A" we wanted but
//      couldn't safely do (Cursor's SQLite write is fragile). OpenCode
//      ships `opencode run` as an official non-interactive CLI so we
//      use it directly.
//   2. Optionally open the TUI at the worktree (default) so the user
//      lands inside the session immediately.
//
// `opencode run` returns when the model has produced its response, so
// we run it detached and unref the child — the CLI exits in ~3s with
// the seed in flight.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

function whichOpencode() {
  if (process.env.ATEM_OPENCODE_BIN) return process.env.ATEM_OPENCODE_BIN;
  try {
    const out = execFileSync('which', ['opencode'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

function makeOpencodeLauncher({ spawnFn = spawn, whichFn = whichOpencode } = {}) {
  return {
    name: 'opencode',

    available() {
      return !!whichFn();
    },

    async launch(input) {
      const bin = whichFn();
      if (!bin) {
        return { kind: 'unavailable', reason: 'opencode binary not on PATH' };
      }
      if (!input.targetRepo || !fs.existsSync(input.targetRepo)) {
        return { kind: 'unavailable', reason: 'targetRepo does not exist' };
      }

      const title = `atem: ${input.syntheticId}${input.fromProvider ? ` ← ${input.fromProvider}` : ''}`;
      const seedMessage = `Pick up the ATEM handoff. Read \`atem://current/handoff\` and \`atem://current/state\` first, then continue from where the previous provider left off.`;

      let child = null;
      let mode = 'tui';

      if (!input.noRespond) {
        // Path A: real session via `opencode run` non-interactive CLI.
        // The named session appears immediately in `opencode session
        // list` and in the TUI sidebar.
        const args = ['run', seedMessage, '--title', title, '--dir', input.targetRepo];
        try {
          child = spawnFn(bin, args, {
            detached: true,
            stdio: 'ignore',
            env: process.env,
          });
          try { child.unref(); } catch { /* harmless */ }
          mode = 'run';
        } catch (e) {
          return { kind: 'unavailable', reason: `opencode run spawn failed: ${e.message}` };
        }
      } else {
        // --no-respond: just open the TUI at the worktree. The user
        // creates the first chat themselves; AGENTS.md provides the
        // contract.
        try {
          child = spawnFn(bin, [input.targetRepo], {
            detached: true,
            stdio: 'ignore',
            env: process.env,
          });
          try { child.unref(); } catch { /* harmless */ }
          mode = 'tui';
        } catch (e) {
          return { kind: 'unavailable', reason: `opencode TUI spawn failed: ${e.message}` };
        }
      }

      const respondBlurb = mode === 'run'
        ? ' Session named and primed; opencode will respond in the background.'
        : ' TUI opened — start a chat to use AGENTS.md.';
      return {
        kind: 'launched',
        summary: `opencode: ${mode === 'run' ? `created session "${title}"` : 'opened TUI at target repo'} (pid ${child.pid || 'unknown'}).${respondBlurb}`,
        metadata: { binary: bin, cwd: input.targetRepo, mode, title, pid: child.pid || null },
      };
    },
  };
}

module.exports = { makeOpencodeLauncher, whichOpencode };
