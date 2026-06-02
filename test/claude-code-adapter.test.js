// Tests for the claude-code adapter and integration:
//   - distillSessionSync over a synthetic transcript
//   - resolveSynthetic returns real markdown (not the placeholder stub)
//   - ingest pulls state into ATEM session files
//   - materializeSyntheticTask handles claude-code synthetic ids
//   - getClaudeSessions stamps a title from the first user message
//   - atem status renders titles for ambient claude-code rows

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

// Build a fake claude-code transcript at the canonical layout.
function writeTranscript(claudeRoot, cwd, sessionId, entries) {
  const projectsDir = path.join(claudeRoot, 'projects', cwd.replace(/[/\\:]/g, '-'));
  fs.mkdirSync(projectsDir, { recursive: true });
  const file = path.join(projectsDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

// Build a process registry file so getClaudeSessions picks the session up.
function writeRegistry(claudeRoot, pid, sessionId, cwd) {
  const dir = path.join(claudeRoot, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({
    pid, sessionId, cwd, startedAt: Date.now(),
    procStart: new Date().toString(), version: 'test', peerProtocol: 1,
    kind: 'interactive', entrypoint: 'claude-desktop',
  }));
}

test('claude-code adapter: distills a transcript with text + tool_use balance', () => {
  const home = mktmp('atem-cc-distill-');
  const claudeRoot = path.join(home, '.claude');
  const cwd = '/Users/example/sites/demo';
  const sessionId = '0000aaaa-0000-aaaa-0000-aaaaaaaaaaaa';
  process.env.ATEM_CLAUDE_CODE_DIR = claudeRoot;
  const file = writeTranscript(claudeRoot, cwd, sessionId, [
    { type: 'queue-operation', operation: 'enqueue', sessionId, timestamp: '2026-01-01T00:00:00Z',
      content: 'Investigate the failing auth tests' },
    { type: 'mode', mode: 'normal', sessionId },
    { sessionId, cwd, message: { role: 'user', content: 'Investigate the failing auth tests' } },
    { sessionId, cwd, message: { role: 'assistant', model: 'claude-opus-4-7',
      content: [
        { type: 'text', text: 'I traced the failure to a race condition in token refresh.' },
        { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: 'src/auth.ts' } },
      ] } },
  ]);

  delete require.cache[require.resolve('../src/adapters/claude-code.js')];
  const cc = require('../src/adapters/claude-code.js');
  const d = cc.distillSessionSync(file);
  assert.equal(d.sessionId, sessionId);
  assert.equal(d.cwd, cwd);
  assert.equal(d.model, 'claude-opus-4-7');
  assert.equal(d.mode, 'normal');
  assert.match(d.firstTask, /Investigate the failing auth tests/);
  assert.match(d.summary, /race condition in token refresh/);
  assert.equal(d.pausedMidTool, true, 'unmatched tool_use should mark paused');
  assert.match(d.title, /Investigate the failing auth tests/);
});

test('claude-code adapter: tool_result closes the balance and clears pausedMidTool', () => {
  const home = mktmp('atem-cc-tool-balance-');
  const claudeRoot = path.join(home, '.claude');
  const cwd = '/Users/example/sites/demo';
  const sessionId = '1111bbbb-1111-bbbb-1111-bbbbbbbbbbbb';
  process.env.ATEM_CLAUDE_CODE_DIR = claudeRoot;
  const file = writeTranscript(claudeRoot, cwd, sessionId, [
    { sessionId, cwd, message: { role: 'user', content: 'go' } },
    { sessionId, cwd, message: { role: 'assistant', model: 'claude-opus-4-7',
      content: [
        { type: 'text', text: 'Calling read.' },
        { type: 'tool_use', id: 'tu-1', name: 'Read', input: {} },
      ] } },
    { sessionId, cwd, message: { role: 'user',
      content: [ { type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' } ] } },
    { sessionId, cwd, message: { role: 'assistant', model: 'claude-opus-4-7',
      content: [ { type: 'text', text: 'Done.' } ] } },
  ]);
  delete require.cache[require.resolve('../src/adapters/claude-code.js')];
  const cc = require('../src/adapters/claude-code.js');
  const d = cc.distillSessionSync(file);
  assert.equal(d.pausedMidTool, false, 'matched tool_result should clear paused flag');
  assert.match(d.summary, /Done\./);
});

test('atem resolve atem://claude-code:<id>/handoff returns real distilled markdown', () => {
  const home = mktmp('atem-cc-resolve-');
  const claudeRoot = path.join(home, '.claude');
  const cwd = '/Users/example/sites/demo';
  const sessionId = '2222cccc-2222-cccc-2222-cccccccccccc';
  writeTranscript(claudeRoot, cwd, sessionId, [
    { sessionId, cwd, message: { role: 'user', content: 'fix the login race' } },
    { sessionId, cwd, message: { role: 'assistant', model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'Patched the lock around token refresh.' }] } },
  ]);

  const env = envFor(home);
  runAtem(['init'], env);
  const out = runAtem(['resolve', `atem://claude-code:${sessionId}/handoff`], env);
  assert.match(out, /Handoff — synthetic/);
  assert.match(out, /Where claude-code left off/);
  assert.match(out, /Patched the lock around token refresh\./);
  // No materialization side effect.
  const sessionsDir = path.join(home, '.atem', 'harness', 'sessions');
  const created = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter((n) => n.startsWith('claude-code:')) : [];
  assert.deepEqual(created, [], 'resolve should not materialize');
});

test('handoff claude-code:<id> --to codex materializes via the claude-code distiller', () => {
  const home = mktmp('atem-cc-handoff-');
  const repo = path.join(home, 'work', 'demo');
  initRepo(repo);
  const claudeRoot = path.join(home, '.claude');
  const sessionId = '3333dddd-3333-dddd-3333-dddddddddddd';
  writeTranscript(claudeRoot, repo, sessionId, [
    { sessionId, cwd: repo, message: { role: 'user', content: 'implement OAuth refresh tokens' } },
    { sessionId, cwd: repo, message: { role: 'assistant', model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'Refresh token flow wired through src/oauth.ts.' }] } },
  ]);

  const env = envFor(home);
  runAtem(['init'], env);
  const synthId = `claude-code:${sessionId}`;
  const out = runAtem(['handoff', synthId, '--to', 'codex', '--repo', repo, '--print'], env);
  assert.match(out, /# ATEM Session Handoff/);

  const dir = path.join(home, '.atem', 'harness', 'sessions', synthId);
  assert.ok(fs.existsSync(dir), 'session dir should be materialized');
  const brief = fs.readFileSync(path.join(dir, 'brief.md'), 'utf8');
  assert.match(brief, /implement OAuth refresh tokens/);
  const state = fs.readFileSync(path.join(dir, 'state.md'), 'utf8');
  assert.match(state, /Refresh token flow wired through src\/oauth\.ts/);
  // Inferred task type from "implement" → implementation
  assert.match(brief, /Task type: implementation/);
});

test('atem status shows a title for ambient claude-code rows when a transcript exists', () => {
  const home = mktmp('atem-cc-status-title-');
  const claudeRoot = path.join(home, '.claude');
  const cwd = path.join(home, 'work', 'demo');
  fs.mkdirSync(cwd, { recursive: true });
  const sessionId = '4444eeee-4444-eeee-4444-eeeeeeeeeeee';
  writeTranscript(claudeRoot, cwd, sessionId, [
    { sessionId, cwd, message: { role: 'user', content: 'audit the cache eviction policy' } },
    { sessionId, cwd, message: { role: 'assistant', model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'Eviction looks LRU; verifying.' }] } },
  ]);
  // Use the live pid so isPidAlive returns true.
  writeRegistry(claudeRoot, process.pid, sessionId, cwd);

  const env = envFor(home);
  runAtem(['init'], env);
  // --all bypasses Phase C.2 auto-scoping (test runs from project root).
  const out = runAtem(['status', '--all'], env);
  assert.match(out, /Detected sessions/);
  assert.match(out, /claude-code:4444ee/);
  assert.match(out, /audit the cache eviction policy/, 'title from first user message should appear');
});
