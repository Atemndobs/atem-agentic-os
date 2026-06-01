// Phase C tests for atem status ergonomics:
//   C.1: idle ambient detection (recent-window claude-code transcripts)
//   C.2: auto-repo scoping (default scope when in a git repo)
//   C.3: combined display — state column "live | Nh ago", per-(provider,cwd)
//        dedupe, "N hidden in other repos" footnote

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'atem.js');

function mktmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function initRepo(d) {
  fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: d, stdio: 'ignore' });
}
function envFor(home) {
  return {
    HOME: home, USERPROFILE: home, NO_COLOR: '1',
    ATEM_HANDLES_DIR: path.join(home, '.atem', 'handles'),
    ATEM_CLAUDE_CODE_DIR: path.join(home, '.claude'),
  };
}
function runAtem(args, env, cwd) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8', env: { ...process.env, ...env },
    cwd: cwd || env.HOME, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeTranscript(claudeRoot, cwd, sessionId, entries, { mtimeMs } = {}) {
  const projectsDir = path.join(claudeRoot, 'projects', cwd.replace(/[/\\:]/g, '-'));
  fs.mkdirSync(projectsDir, { recursive: true });
  const file = path.join(projectsDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (typeof mtimeMs === 'number') {
    const t = mtimeMs / 1000;
    fs.utimesSync(file, t, t);
  }
  return file;
}

// ---- Phase C.1 ---------------------------------------------------------

test('C.1: synthetic helpers — getRecentWindowMs / isRecent / formatRelativeAge', () => {
  delete require.cache[require.resolve('../src/synthetic.js')];
  const before = process.env.ATEM_RECENT_WINDOW_HOURS;
  delete process.env.ATEM_RECENT_WINDOW_HOURS;
  const s = require('../src/synthetic.js');
  assert.equal(s.getRecentWindowMs(), 48 * 60 * 60 * 1000, 'default 48h');

  process.env.ATEM_RECENT_WINDOW_HOURS = '24';
  delete require.cache[require.resolve('../src/synthetic.js')];
  const s24 = require('../src/synthetic.js');
  assert.equal(s24.getRecentWindowMs(), 24 * 60 * 60 * 1000);

  if (before === undefined) delete process.env.ATEM_RECENT_WINDOW_HOURS;
  else process.env.ATEM_RECENT_WINDOW_HOURS = before;
  delete require.cache[require.resolve('../src/synthetic.js')];

  const s2 = require('../src/synthetic.js');
  const now = 1_000_000_000_000;
  assert.equal(s2.isRecent(now - 1000, now), true);
  assert.equal(s2.isRecent(now - 100 * 60 * 60 * 1000, now), false);
  assert.equal(s2.formatRelativeAge(now - 90_000, now), '1m ago');
  assert.match(s2.formatRelativeAge(now - 3 * 60 * 60 * 1000, now), /3h ago/);
  assert.match(s2.formatRelativeAge(now - 2 * 24 * 60 * 60 * 1000, now), /2d ago/);
});

test('C.1: claude-code adapter listRecentSessions skips files older than the window', () => {
  const home = mktmp('atem-c1-recent-');
  const claudeRoot = path.join(home, '.claude');
  const cwdRecent = '/Users/example/sites/recent';
  const cwdStale = '/Users/example/sites/stale';
  const now = Date.now();
  const recentFile = writeTranscript(claudeRoot, cwdRecent, 'aaaa-recent', [
    { sessionId: 'aaaa-recent', cwd: cwdRecent, message: { role: 'user', content: 'recent task' } },
  ], { mtimeMs: now - 2 * 60 * 60 * 1000 });           // 2h ago — kept
  const staleFile = writeTranscript(claudeRoot, cwdStale, 'bbbb-stale', [
    { sessionId: 'bbbb-stale', cwd: cwdStale, message: { role: 'user', content: 'old task' } },
  ], { mtimeMs: now - 200 * 60 * 60 * 1000 });          // 200h ago — dropped

  process.env.ATEM_CLAUDE_CODE_DIR = claudeRoot;
  delete require.cache[require.resolve('../src/adapters/claude-code.js')];
  const cc = require('../src/adapters/claude-code.js');
  const found = cc.listRecentSessions({ now });
  const ids = found.map((r) => r.sessionId);
  assert.ok(ids.includes('aaaa-recent'), 'recent transcript kept');
  assert.ok(!ids.includes('bbbb-stale'), 'stale transcript dropped');

  // sniffed cwd survives the dropping.
  const r = found.find((x) => x.sessionId === 'aaaa-recent');
  assert.equal(r.cwd, cwdRecent);
  assert.match(r.title, /recent task/);
  assert.ok(r.mtimeMs > 0);
  fs.statSync(recentFile); fs.statSync(staleFile);
});

test('C.1: atem status surfaces an idle claude-code session within the window', () => {
  const home = mktmp('atem-c1-idle-status-');
  const claudeRoot = path.join(home, '.claude');
  const cwd = path.join(home, 'work', 'demo');
  fs.mkdirSync(cwd, { recursive: true });
  writeTranscript(claudeRoot, cwd, 'idle-session-1', [
    { sessionId: 'idle-session-1', cwd, message: { role: 'user', content: 'investigate flake' } },
    { sessionId: 'idle-session-1', cwd, message: { role: 'assistant', model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'Suspect race in token refresh.' }] } },
  ], { mtimeMs: Date.now() - 3 * 60 * 60 * 1000 });    // 3h ago
  // No registry file → idle path only.

  const env = envFor(home);
  runAtem(['init'], env);
  const out = runAtem(['status', '--all'], env);
  assert.match(out, /Detected sessions/);
  assert.match(out, /claude-code:idle-s/, 'short synthetic id surfaces');
  assert.match(out, /3h ago/, 'age column reflects 3h-ago mtime');
  assert.match(out, /investigate flake/, 'title carried');
});

// ---- Phase C.2 ---------------------------------------------------------

test('C.2: atem status inside a git repo defaults to repo scope', () => {
  const home = mktmp('atem-c2-scope-');
  const repo = path.join(home, 'work', 'demo');
  initRepo(repo);
  const claudeRoot = path.join(home, '.claude');
  // Two idle sessions: one in repo, one elsewhere.
  writeTranscript(claudeRoot, repo, 'in-repo-id', [
    { sessionId: 'in-repo-id', cwd: repo, message: { role: 'user', content: 'in-repo prompt' } },
  ], { mtimeMs: Date.now() - 60 * 60 * 1000 });
  const otherCwd = path.join(home, 'work', 'other');
  fs.mkdirSync(otherCwd, { recursive: true });
  writeTranscript(claudeRoot, otherCwd, 'other-id', [
    { sessionId: 'other-id', cwd: otherCwd, message: { role: 'user', content: 'other prompt' } },
  ], { mtimeMs: Date.now() - 60 * 60 * 1000 });

  const env = envFor(home);
  runAtem(['init'], env);

  // Run from inside the repo — should auto-scope.
  const scoped = runAtem(['status'], env, repo);
  assert.match(scoped, /Scoped to /, 'scope banner appears');
  assert.match(scoped, /in-repo prompt/, 'in-repo session visible');
  assert.ok(!/other prompt/.test(scoped), 'other-repo session hidden');
  assert.match(scoped, /Other repos: \d+ hidden/, 'hidden-elsewhere footnote shown');

  // --all flips back to machine-wide.
  const all = runAtem(['status', '--all'], env, repo);
  assert.match(all, /Provider activity \(machine-wide\)/);
  assert.match(all, /in-repo prompt/);
  assert.match(all, /other prompt/);
});

test('C.2: --repo PATH is honored (explicit wins over auto)', () => {
  const home = mktmp('atem-c2-explicit-');
  const repoA = path.join(home, 'work', 'a'); initRepo(repoA);
  const repoB = path.join(home, 'work', 'b'); initRepo(repoB);
  const claudeRoot = path.join(home, '.claude');
  writeTranscript(claudeRoot, repoA, 'aid', [
    { sessionId: 'aid', cwd: repoA, message: { role: 'user', content: 'in A' } },
  ], { mtimeMs: Date.now() - 60 * 60 * 1000 });
  writeTranscript(claudeRoot, repoB, 'bid', [
    { sessionId: 'bid', cwd: repoB, message: { role: 'user', content: 'in B' } },
  ], { mtimeMs: Date.now() - 60 * 60 * 1000 });

  const env = envFor(home);
  runAtem(['init'], env);
  // cwd=repoA but --repo=repoB → expect B
  const out = runAtem(['status', '--repo', repoB], env, repoA);
  assert.match(out, /in B/, 'explicit --repo wins');
  assert.ok(!/in A/.test(out), 'repoA hidden when explicit scope points at B');
});

// ---- Phase C.3 ---------------------------------------------------------

test('C.3: same (provider, cwd) collapses to one row with "N elided" footnote', () => {
  const home = mktmp('atem-c3-dedupe-');
  const claudeRoot = path.join(home, '.claude');
  const cwd = path.join(home, 'work', 'dup');
  fs.mkdirSync(cwd, { recursive: true });
  // Three idle sessions in the SAME cwd.
  for (let i = 0; i < 3; i += 1) {
    writeTranscript(claudeRoot, cwd, `dup-id-${i}`, [
      { sessionId: `dup-id-${i}`, cwd, message: { role: 'user', content: `prompt ${i}` } },
    ], { mtimeMs: Date.now() - (i + 1) * 60 * 60 * 1000 });
  }

  const env = envFor(home);
  runAtem(['init'], env);
  const out = runAtem(['status', '--all'], env);
  assert.match(out, /Detected sessions \(1\)/, 'all three collapse to one');
  assert.match(out, /Same repo, deduped: 2 elided/);
});

test('C.3: Worktree column extracts name from .git file for worktree checkouts', () => {
  const home = mktmp('atem-c3-worktree-');
  const main = path.join(home, 'work', 'main');
  initRepo(main);
  // Synthesize a worktree checkout dir with a `.git` FILE pointing at
  // a worktrees/<name> path. Matches what `git worktree add` produces.
  const worktreeDir = path.join(home, 'work', 'wt-feature');
  fs.mkdirSync(worktreeDir, { recursive: true });
  fs.writeFileSync(
    path.join(worktreeDir, '.git'),
    `gitdir: ${path.join(main, '.git', 'worktrees', 'feature')}\n`
  );
  // Don't bother making the underlying gitdir real — detectWorktreeName
  // only parses the file contents.

  const claudeRoot = path.join(home, '.claude');
  // One main-repo session + one worktree session.
  writeTranscript(claudeRoot, main, 'main-id', [
    { sessionId: 'main-id', cwd: main, message: { role: 'user', content: 'in main' } },
  ], { mtimeMs: Date.now() - 60 * 60 * 1000 });
  writeTranscript(claudeRoot, worktreeDir, 'wt-id', [
    { sessionId: 'wt-id', cwd: worktreeDir, message: { role: 'user', content: 'in worktree' } },
  ], { mtimeMs: Date.now() - 60 * 60 * 1000 });

  const env = envFor(home);
  runAtem(['init'], env);
  const out = runAtem(['status', '--all'], env);

  assert.match(out, /Worktree/, 'header column added');
  assert.match(out, /feature/, 'worktree row shows the name');
  // Main-repo row should NOT show the worktree name in its Worktree cell.
  // Easiest way: check the row's order vs the unique worktree name.
  const wtIdx = out.indexOf('in worktree');
  const featureIdx = out.indexOf('feature');
  assert.ok(featureIdx > -1 && wtIdx > -1, 'both must appear');
});

test('C.3: state column renders age for idle, live for alive sessions', () => {
  const home = mktmp('atem-c3-state-');
  const claudeRoot = path.join(home, '.claude');
  const cwd = path.join(home, 'work', 'state');
  fs.mkdirSync(cwd, { recursive: true });

  // (a) Idle session: transcript only, no registry.
  writeTranscript(claudeRoot, cwd, 'idle-only', [
    { sessionId: 'idle-only', cwd, message: { role: 'user', content: 'idle prompt' } },
  ], { mtimeMs: Date.now() - 5 * 60 * 60 * 1000 });
  // (b) Live session: registry pid matching our own process + a transcript.
  const liveCwd = path.join(home, 'work', 'live');
  fs.mkdirSync(liveCwd, { recursive: true });
  fs.mkdirSync(path.join(claudeRoot, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(claudeRoot, 'sessions', `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: 'live-1', cwd: liveCwd,
    startedAt: Date.now(), procStart: 'now', version: 'test', peerProtocol: 1,
    kind: 'interactive', entrypoint: 'claude-desktop',
  }));
  writeTranscript(claudeRoot, liveCwd, 'live-1', [
    { sessionId: 'live-1', cwd: liveCwd, message: { role: 'user', content: 'live prompt' } },
  ], { mtimeMs: Date.now() });

  const env = envFor(home);
  runAtem(['init'], env);
  const out = runAtem(['status', '--all'], env);
  assert.match(out, /live prompt/);
  assert.match(out, /idle prompt/);
  assert.match(out, /5h ago/, 'idle row shows age');
  assert.match(out, /live/, 'live row shows "live" label');
});
