// Cursor launcher.
//
// Path B from G.1.1 research: write `.cursorrules` at the repo root
// with the ATEM handoff contract, then spawn `cursor <repo>` to open
// the IDE pointed at the worktree. The user clicks "New chat" and
// Cursor's model auto-reads `.cursorrules` on first turn, picking up
// the contract.
//
// We don't try to pre-create a chat thread in Cursor's SQLite from
// the launcher today. The Cursor app doesn't expose a JSON-RPC bridge
// like Codex does and the URL scheme is auth-callback-only — no
// `cursor://open?path=...` deep-link. Path A (direct SQLite write)
// would work but needs a Cursor restart to refresh the sidebar
// in-process; deferred until we hit the friction.
//
// `cursor` binary is a shell wrapper at /usr/local/bin/cursor (or the
// equivalent install path). It's symlinked to
// /Applications/Cursor.app/Contents/Resources/app/bin/code.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const CURSORRULES_BEGIN = '<!-- atem:cursorrules:begin -->';
const CURSORRULES_END = '<!-- atem:cursorrules:end -->';

function whichCursor() {
  if (process.env.ATEM_CURSOR_BIN) return process.env.ATEM_CURSOR_BIN;
  try {
    const out = execFileSync('which', ['cursor'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

// Build the ATEM block we drop into `.cursorrules`. Mirrors the
// AGENTS.md handoff block: clearly marked so we can update only our
// section without clobbering human-authored rules around it.
function buildCursorRulesBlock({ syntheticId, taskType, fromProvider, targetRepo }) {
  return [
    CURSORRULES_BEGIN,
    '# ATEM Session Contract',
    '',
    'This repository is participating in an ATEM session-handoff workflow.',
    `Active task: \`${syntheticId}\` (type: \`${taskType}\`)${fromProvider ? `, previous provider: \`${fromProvider}\`` : ''}.`,
    '',
    '## Before doing anything',
    '',
    'Read the active session files. Prefer the stable URL form — same path',
    'regardless of harness mode or future layout changes:',
    '',
    '- `atem://current/brief` — what this task is',
    '- `atem://current/state` — current state',
    '- `atem://current/handoff` — what the previous provider left for you',
    '- `atem://current/next` — what to do next',
    '- `atem://current/decisions` — past decisions you must respect',
    '',
    'Dereference from a shell with `atem resolve <url>`. Same files are',
    'symlinked under `~/.atem/handles/current/*.md` for tools that only',
    'accept literal local paths.',
    '',
    '## Repository boundary',
    '',
    `Only modify files inside \`${targetRepo || '(target repo)'}\`. Never touch sibling repos or sibling worktrees.`,
    '',
    '## Before stopping',
    '',
    'Update the session files (`handoff.md`, `state.md`, `next.md`, `log.md`, and `decisions.md` when relevant).',
    'Never end without updating `handoff.md`.',
    '',
    `Managed by ATEM. Edit content above/below this block, but leave this block intact — \`atem handoff\` regenerates it.`,
    CURSORRULES_END,
    '',
  ].join('\n');
}

// Idempotent write: replaces our marked block, leaves the rest alone.
function writeCursorRules(repo, blockText) {
  if (!repo || !fs.existsSync(repo)) return null;
  const dest = path.join(repo, '.cursorrules');
  let next;
  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, 'utf8');
    if (existing.includes(CURSORRULES_BEGIN) && existing.includes(CURSORRULES_END)) {
      const before = existing.slice(0, existing.indexOf(CURSORRULES_BEGIN));
      const after = existing
        .slice(existing.indexOf(CURSORRULES_END) + CURSORRULES_END.length)
        .replace(/^\n+/, '');
      next = before + blockText + after;
    } else {
      next = existing.replace(/\n*$/, '\n\n') + blockText;
    }
  } else {
    next = blockText;
  }
  fs.writeFileSync(dest, next);
  return dest;
}

function makeCursorLauncher({ spawnFn = spawn, whichFn = whichCursor, writeRulesFn = writeCursorRules } = {}) {
  return {
    name: 'cursor',

    available() {
      return !!whichFn();
    },

    async launch(input) {
      const bin = whichFn();
      if (!bin) {
        return { kind: 'unavailable', reason: 'cursor binary not on PATH' };
      }
      if (!input.targetRepo || !fs.existsSync(input.targetRepo)) {
        return { kind: 'unavailable', reason: 'targetRepo does not exist' };
      }

      const block = buildCursorRulesBlock({
        syntheticId: input.syntheticId,
        taskType: input.taskType,
        fromProvider: input.fromProvider,
        targetRepo: input.targetRepo,
      });
      const rulesPath = writeRulesFn(input.targetRepo, block);

      // Open Cursor at the worktree. `--reuse-window` keeps the user's
      // existing window if they already have Cursor open — opening a
      // new window every handoff feels disruptive.
      const args = ['--reuse-window', input.targetRepo];
      let child;
      try {
        child = spawnFn(bin, args, {
          detached: true,
          stdio: 'ignore',
          env: process.env,
        });
        try { child.unref(); } catch { /* harmless */ }
      } catch (e) {
        return { kind: 'unavailable', reason: `cursor spawn failed: ${e.message}` };
      }

      const rulesNote = rulesPath ? ` ${path.relative(input.targetRepo, rulesPath) || '.cursorrules'} updated.` : '';
      return {
        kind: 'launched',
        summary: `cursor: opened ${input.targetRepo} (pid ${child.pid || 'unknown'}).${rulesNote} Click "New chat" — Cursor will read .cursorrules on first turn.`,
        metadata: { binary: bin, cwd: input.targetRepo, cursorrulesPath: rulesPath },
      };
    },
  };
}

module.exports = {
  makeCursorLauncher,
  whichCursor,
  buildCursorRulesBlock,
  writeCursorRules,
  CURSORRULES_BEGIN,
  CURSORRULES_END,
};
