// Tests for F.1 — project context auto-discovery.
//
// Synthetic repos seeded with the document conventions we expect:
//   docs/action-plan.md, docs/sub-plan-*.md, docs/research/*.md,
//   docs/decisions/*.md, ADR/*, .planning/*, PROJECT.md, ROADMAP.md.
// Verifies:
//   1. discoverProjectContext returns the right shape per layout
//   2. renderProjectContextSection produces a stable markdown block
//   3. buildHandoffPrompt embeds the section when docs exist, omits
//      otherwise

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ctx = require('../src/context.js');

function mktmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function touch(file, body = '# title\n\nbody\n', mtime = null) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (mtime) {
    const ts = mtime / 1000;
    fs.utimesSync(file, ts, ts);
  }
}

// --- F.1.1: discoverProjectContext ---------------------------------------

test('F.1.1: returns empty shape for non-existent or empty repos', () => {
  const empty = mktmp('atem-pc-empty-');
  const r = ctx.discoverProjectContext(empty);
  assert.equal(r.purpose, null);
  assert.deepEqual(r.plans, []);
  assert.deepEqual(r.research, []);
  assert.deepEqual(r.decisions, []);

  const missing = ctx.discoverProjectContext('/no/such/path');
  assert.equal(missing.purpose, null);
});

test('F.1.1: picks docs/action-plan.md as purpose when present', () => {
  const repo = mktmp('atem-pc-purpose-');
  touch(path.join(repo, 'docs', 'action-plan.md'), '# ATEM Agentic OS — Action Plan\n\nThe plan.\n');
  const r = ctx.discoverProjectContext(repo);
  assert.ok(r.purpose, 'purpose should not be null');
  assert.equal(path.basename(r.purpose.path), 'action-plan.md');
  assert.match(r.purpose.title, /ATEM Agentic OS/);
});

test('F.1.1: PROJECT.md wins over ROADMAP.md when both exist (priority order)', () => {
  const repo = mktmp('atem-pc-priority-');
  touch(path.join(repo, 'ROADMAP.md'), '# Roadmap\n');
  touch(path.join(repo, 'PROJECT.md'), '# Project\n');
  // PROJECT.md comes before ROADMAP.md in PURPOSE_CANDIDATES
  const r = ctx.discoverProjectContext(repo);
  // docs/action-plan.md is highest priority, then docs/PROJECT.md, then PROJECT.md, then docs/ROADMAP.md, then ROADMAP.md
  assert.equal(path.basename(r.purpose.path), 'PROJECT.md');
});

test('F.1.1: surfaces newest sub-plans by mtime, max 4', () => {
  const repo = mktmp('atem-pc-plans-');
  const now = Date.now();
  for (let i = 0; i < 6; i += 1) {
    touch(
      path.join(repo, 'docs', `sub-plan-foo-${i}.md`),
      `# Sub-plan ${i}\n`,
      now - i * 60 * 60 * 1000
    );
  }
  const r = ctx.discoverProjectContext(repo);
  assert.equal(r.plans.length, 4, 'plans capped at 4');
  // Newest first → sub-plan-foo-0 should be at index 0
  assert.equal(path.basename(r.plans[0].path), 'sub-plan-foo-0.md');
  assert.equal(path.basename(r.plans[3].path), 'sub-plan-foo-3.md');
});

test('F.1.1: research dirs scanned recursively', () => {
  const repo = mktmp('atem-pc-research-');
  touch(path.join(repo, 'docs', 'research', 'omp-session-layout.md'), '# omp layout\n');
  touch(path.join(repo, 'docs', 'research', 'sub', 'nested-finding.md'), '# nested finding\n');
  const r = ctx.discoverProjectContext(repo);
  const names = r.research.map((x) => path.basename(x.path)).sort();
  assert.deepEqual(names, ['nested-finding.md', 'omp-session-layout.md']);
});

test('F.1.1: ADR/, adr/, docs/decisions/ all recognized as decisions', () => {
  const repo = mktmp('atem-pc-decisions-');
  touch(path.join(repo, 'ADR', '001-record.md'), '# ADR-001\n');
  touch(path.join(repo, 'docs', 'decisions', '002-record.md'), '# Decision 002\n');
  touch(path.join(repo, '.planning', 'decisions', '003-record.md'), '# Decision 003\n');
  const r = ctx.discoverProjectContext(repo);
  const names = r.decisions.map((x) => path.basename(x.path)).sort();
  assert.deepEqual(names, ['001-record.md', '002-record.md', '003-record.md']);
});

// --- F.1.2: renderProjectContextSection ----------------------------------

test('F.1.2: renderProjectContextSection returns "" when nothing found', () => {
  const block = ctx.renderProjectContextSection({
    purpose: null, plans: [], research: [], decisions: [],
  });
  assert.equal(block, '');
});

test('F.1.2: section block names each category and lists paths', () => {
  const repo = mktmp('atem-pc-render-');
  touch(path.join(repo, 'docs', 'action-plan.md'), '# Action plan\n');
  touch(path.join(repo, 'docs', 'sub-plan-handoff.md'), '# Sub-plan handoff\n');
  touch(path.join(repo, 'docs', 'research', 'codex-bridge.md'), '# Codex bridge\n');
  touch(path.join(repo, 'ADR', '001-task-ids.md'), '# Task ids ADR\n');

  const block = ctx.renderProjectContextSection(ctx.discoverProjectContext(repo));
  assert.match(block, /## Project Context/);
  assert.match(block, /Why \(project purpose\)/);
  assert.match(block, /Plans \(what we're building/);
  assert.match(block, /Research \(priors and context\)/);
  assert.match(block, /Decisions \(don't relitigate\)/);
  assert.match(block, /action-plan\.md/);
  assert.match(block, /sub-plan-handoff\.md/);
  assert.match(block, /codex-bridge\.md/);
  assert.match(block, /001-task-ids\.md/);
});

// --- buildHandoffPrompt integration --------------------------------------

const CLI = path.join(__dirname, '..', 'bin', 'atem.js');
function initRepo(d) {
  fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: d, stdio: 'ignore' });
}
function runAtem(args, env, cwd) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8', env: { ...process.env, ...env },
    cwd: cwd || env.HOME, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function envFor(home) {
  return { HOME: home, USERPROFILE: home, NO_COLOR: '1', ATEM_HANDLES_DIR: path.join(home, '.atem', 'handles') };
}

test('F.1: handoff --print includes Project Context block when docs exist', () => {
  const home = mktmp('atem-pc-handoff-');
  const repo = path.join(home, 'work', 'demo');
  initRepo(repo);
  touch(path.join(repo, 'docs', 'action-plan.md'), '# ATEM Action Plan\n');
  touch(path.join(repo, 'docs', 'sub-plan-foo.md'), '# Sub-plan foo\n');
  touch(path.join(repo, 'docs', 'research', 'survey.md'), '# Survey\n');

  const env = envFor(home);
  runAtem(['init'], env);
  runAtem(['start', 'Context test', '--type', 'implementation', '--repo', repo], env);
  const sessionsDir = path.join(home, '.atem', 'harness', 'sessions');
  const taskId = fs.readdirSync(sessionsDir)[0];

  const out = runAtem(['handoff', taskId, '--to', 'codex', '--repo', repo, '--print'], env);
  assert.match(out, /## Project Context/, 'project context section emitted');
  assert.match(out, /action-plan\.md/);
  assert.match(out, /sub-plan-foo\.md/);
  assert.match(out, /survey\.md/);
});

test('F.1: handoff --print omits Project Context when no docs exist', () => {
  const home = mktmp('atem-pc-handoff-empty-');
  const repo = path.join(home, 'work', 'no-docs');
  initRepo(repo);
  const env = envFor(home);
  runAtem(['init'], env);
  runAtem(['start', 'No docs', '--type', 'implementation', '--repo', repo], env);
  const sessionsDir = path.join(home, '.atem', 'harness', 'sessions');
  const taskId = fs.readdirSync(sessionsDir)[0];

  const out = runAtem(['handoff', taskId, '--to', 'codex', '--repo', repo, '--print'], env);
  assert.ok(!/## Project Context/.test(out), 'no Project Context when no docs found');
});
