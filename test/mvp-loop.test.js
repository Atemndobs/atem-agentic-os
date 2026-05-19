// MVP validation loop — action-plan §Immediate MVP Validation Goal.
// Walks the canonical sequence end-to-end and verifies invariants:
//   continuity, repo boundaries, task intent, deterministic state,
//   understandable handoff.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ATEM = path.join(__dirname, '..', 'bin', 'atem.js');

function makeTempHarness() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'atem-mvp-'));
  const env = { ...process.env, HOME: tmpHome, ATEM_HARNESS_MODE: 'global' };
  const run = (args, opts = {}) => execFileSync('node', [ATEM, ...args], {
    env,
    encoding: 'utf8',
    cwd: opts.cwd || tmpHome,
  });
  return { tmpHome, run };
}

function makeGitRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'init\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

test('MVP loop: start → route → handoff → snapshot → switch provider → snapshot → doctor', () => {
  const { tmpHome, run } = makeTempHarness();
  const repo = makeGitRepo('mvp-repo');

  // 1. start
  run(['init']);
  const startOut = run(['start', 'Add provider handoff docs', '--type', 'implementation', '--repo', repo]);
  assert.match(startOut, /TASK-001/);

  // 2. route to claude-code, handoff
  run(['route', 'TASK-001', '--to', 'claude-code', '--repo', repo]);
  const handoff1 = run(['handoff', 'TASK-001']);

  // Handoff must reference the repo, the task type, and the session files.
  assert.match(handoff1, /implementation task/);
  assert.match(handoff1, new RegExp(repo.replace(/[/]/g, '\\/')));
  assert.match(handoff1, /handoff\.md/);

  // 3. first snapshot (no diff yet, but recorded)
  execFileSync('sleep', ['1']);
  run(['snapshot', 'TASK-001', '--repo', repo]);

  // Simulate provider doing some work — add a file in the repo.
  fs.writeFileSync(path.join(repo, 'docs.md'), 'hello\n');

  // 4. route to codex, handoff again
  execFileSync('sleep', ['1']);
  run(['route', 'TASK-001', '--to', 'codex', '--repo', repo]);
  const handoff2 = run(['handoff', 'TASK-001']);
  assert.match(handoff2, /implementation task/);
  assert.match(handoff2, /codex|Target Provider/);

  // 5. second snapshot
  run(['snapshot', 'TASK-001', '--repo', repo]);

  // 6. doctor must pass (no FAIL lines) — repo exists, task type valid.
  const doctorOut = run(['doctor']);
  assert.doesNotMatch(doctorOut, /^\[FAIL\]/m);
  assert.match(doctorOut, /schema: atem\.session\.v1/);
  assert.match(doctorOut, /task type is valid: implementation/);
  assert.match(doctorOut, /repository present and exists/);

  // 7. snapshot-diff should show provider transition claude-code → codex
  const diffOut = run(['snapshot-diff', 'TASK-001']);
  assert.match(diffOut, /claude-code → codex/);

  // Deterministic state: re-running adopt should not duplicate provider blocks.
  // (Idempotency invariant from existing tests still holds across the loop.)
  const statePath = path.join(tmpHome, '.atem', 'harness', 'sessions', 'TASK-001', 'state.md');
  const state = fs.readFileSync(statePath, 'utf8');
  const providerSections = (state.match(/^## Active Providers/gm) || []).length;
  assert.ok(providerSections <= 1, `expected at most one Active Providers section, found ${providerSections}`);
});
