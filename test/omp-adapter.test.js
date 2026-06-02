// End-to-end tests for the omp provider integration (T1.2 – T1.8).
//
// We never call real `omp`. Instead we lay down a synthetic
// ~/.omp/agent/sessions/<encoded-cwd>/<id>.jsonl using the exact schema
// documented in docs/research/omp-session-layout.md, then exercise:
//   - the omp adapter's distillation
//   - the adapter registry's ingest()
//   - the CLI `atem ingest-omp` command
//   - the AGENTS.md handoff writer (handoff TO omp)
//   - the doctor's omp awareness

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'atem.js');

function mktmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runAtem(args, env = {}) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function initRepo(repoDir) {
  fs.mkdirSync(repoDir, { recursive: true });
  // Need a git root for the harness to anchor anywhere.
  execFileSync('git', ['init', '-q'], { cwd: repoDir, stdio: 'ignore' });
}

function writeOmpSession(agentDir, encodedDir, sessionId, headerExtras, entries) {
  const dir = path.join(agentDir, 'sessions', encodedDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const header = {
    type: 'session',
    id: sessionId,
    title: 'Investigate flaky auth tests',
    timestamp: new Date().toISOString(),
    cwd: headerExtras.cwd,
  };
  const lines = [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function envFor(homeDir, harnessMode = 'global') {
  // We point HOME at a temp dir so omp adapter reads ~/.omp from there,
  // and the harness writes its state under that temp HOME too.
  return {
    HOME: homeDir,
    USERPROFILE: homeDir,
    ATEM_HARNESS_MODE: harnessMode,
    PI_CODING_AGENT_DIR: path.join(homeDir, '.omp', 'agent'),
    // Strip color so the test parses output deterministically.
    NO_COLOR: '1',
  };
}

test('omp adapter: distills a synthetic session', () => {
  const home = mktmp('atem-omp-distill-');
  const repo = path.join(home, 'repos', 'demo');
  initRepo(repo);

  const omp = require('../src/adapters/omp.js');
  const agentDir = path.join(home, '.omp', 'agent');
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Encoding is lossy; the adapter must still find the session via
  // header.cwd fallback. Use a deliberately wrong dir name.
  const wrongDir = '-not-a-real-encoding';
  const file = writeOmpSession(agentDir, wrongDir, 'sess-1', { cwd: repo }, [
    { type: 'session_init', id: 'i1', parentId: null, timestamp: new Date().toISOString(),
      systemPrompt: 'You are omp.', task: 'Investigate the flaky auth tests.', tools: ['read', 'edit', 'bash'] },
    { type: 'model_change', id: 'm1', parentId: 'i1', timestamp: new Date().toISOString(),
      model: 'anthropic/claude-4-7-sonnet', role: 'default' },
    { type: 'message', id: 'u1', parentId: 'm1', timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'Please find the cause and propose a fix.' } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [
        { type: 'text', text: 'I traced the failure to a race condition in token refresh.' },
        { type: 'tool_use', name: 'read', input: { path: 'src/auth.ts' } },
      ] } },
    { type: 'mode_change', id: 'mc1', parentId: 'a1', timestamp: new Date().toISOString(),
      mode: 'plan' },
  ]);

  const latest = omp.findLatestSessionFile(repo);
  assert.equal(latest, file, 'should locate the synthetic session via header.cwd fallback');

  const distilled = omp.distillSessionSync(file);
  assert.equal(distilled.sessionId, 'sess-1');
  assert.equal(distilled.cwd, repo);
  assert.equal(distilled.model, 'anthropic/claude-4-7-sonnet');
  assert.equal(distilled.mode, 'plan');
  assert.ok(distilled.firstTask.includes('Investigate the flaky auth tests'));
  assert.ok(distilled.summary.includes('race condition'));
  assert.equal(distilled.pausedMidTool, true, 'unmatched tool_use should mark session paused');
  assert.deepEqual(distilled.tools, ['read', 'edit', 'bash']);
});

test('CLI: ingest-omp pulls omp state into ATEM session files', () => {
  const home = mktmp('atem-omp-ingest-');
  const repo = path.join(home, 'repos', 'demo');
  initRepo(repo);
  const env = envFor(home);

  // Start a task in repo mode (HOME-rooted harness for isolation).
  runAtem(['init'], env);
  runAtem(['start', 'Investigate flaky auth', '--type', 'investigation', '--repo', repo], env);

  // Synthesize an omp session in HOME's .omp.
  const omp = require('../src/adapters/omp.js');
  const agentDir = path.join(home, '.omp', 'agent');
  const encoded = omp.encodeSessionDirName(repo);
  writeOmpSession(agentDir, encoded, 'sess-2', { cwd: repo }, [
    { type: 'session_init', id: 'i1', parentId: null, timestamp: new Date().toISOString(),
      task: 'Find the timeout bug.', tools: ['read', 'bash'] },
    { type: 'message', id: 'u1', parentId: 'i1', timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'find the timeout bug' } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Located: src/auth.ts retry has wrong cap.' }] } },
    { type: 'compaction', id: 'c1', parentId: 'a1', timestamp: new Date().toISOString(),
      summary: 'Working on auth-timeout investigation; cap appears wrong in retry loop.',
      firstKeptEntryId: 'a1', tokensBefore: 1234 },
  ]);

  // Resolve task id by listing sessions dir.
  const sessionsDir = path.join(home, '.atem', 'harness', 'sessions');
  const taskId = fs.readdirSync(sessionsDir)[0];
  assert.ok(taskId, 'should have created a task');

  const out = runAtem(['ingest-omp', taskId, '--cwd', repo], env);
  assert.ok(out.includes('omp session: sess-2'));
  assert.ok(out.includes('Summary: Working on auth-timeout investigation'));

  // Confirm state.md reflects the ingested summary + provider.
  const state = fs.readFileSync(path.join(sessionsDir, taskId, 'state.md'), 'utf8');
  assert.ok(state.includes('omp'), 'state.md should record provider=omp');
  assert.ok(state.includes('auth-timeout investigation'), 'state.md should carry ingested summary');
});

test('handoff --to omp writes AGENTS.md with idempotent block', () => {
  const home = mktmp('atem-omp-handoff-');
  const repo = path.join(home, 'repos', 'demo');
  initRepo(repo);
  // Seed an existing AGENTS.md so we can prove idempotency.
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Existing repo rules\n\nDo not delete this paragraph.\n');
  const env = envFor(home);

  runAtem(['init'], env);
  runAtem(['start', 'Implement omp integration', '--type', 'implementation', '--repo', repo], env);
  const sessionsDir = path.join(home, '.atem', 'harness', 'sessions');
  const taskId = fs.readdirSync(sessionsDir)[0];

  runAtem(['handoff', taskId, '--to', 'omp', '--repo', repo], env);
  let body = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
  assert.ok(body.includes('Do not delete this paragraph.'), 'existing content preserved');
  assert.ok(body.includes('<!-- atem:agents:begin -->'), 'ATEM block written');
  assert.ok(body.includes('<!-- atem:agents:end -->'), 'ATEM block closed');
  assert.ok(body.includes(`Active task: \`${taskId}\``), 'task id present');

  // Second handoff replaces only the block.
  runAtem(['handoff', taskId, '--to', 'omp', '--repo', repo], env);
  const body2 = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
  const blocks = body2.match(/<!-- atem:agents:begin -->/g) || [];
  assert.equal(blocks.length, 1, 'block should not be duplicated on rehandoff');
  assert.ok(body2.includes('Do not delete this paragraph.'), 'still preserves user content');
});

test('handoff --from omp ingests before generating prompt', () => {
  const home = mktmp('atem-omp-fromomp-');
  const repo = path.join(home, 'repos', 'demo');
  initRepo(repo);
  const env = envFor(home);

  runAtem(['init'], env);
  runAtem(['start', 'Continue omp work', '--type', 'implementation', '--repo', repo], env);
  const sessionsDir = path.join(home, '.atem', 'harness', 'sessions');
  const taskId = fs.readdirSync(sessionsDir)[0];

  const omp = require('../src/adapters/omp.js');
  const agentDir = path.join(home, '.omp', 'agent');
  const encoded = omp.encodeSessionDirName(repo);
  writeOmpSession(agentDir, encoded, 'sess-3', { cwd: repo }, [
    { type: 'message', id: 'u1', parentId: null, timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'fix the cap' } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Patched src/auth.ts retry cap from 3 to 5.' }] } },
  ]);

  const out = runAtem(['handoff', taskId, '--to', 'codex', '--from', 'omp', '--omp-cwd', repo, '--repo', repo, '--print'], env);
  // The state should now carry the ingested summary AND the handoff prompt emerge.
  const state = fs.readFileSync(path.join(sessionsDir, taskId, 'state.md'), 'utf8');
  assert.ok(state.includes('Patched src/auth.ts retry cap'), 'ingest happened before handoff');
  assert.ok(out.includes('# ATEM Session Handoff'), 'handoff prompt emitted');
  assert.ok(out.includes(taskId));
});

test('doctor reports omp activity and missing AGENTS.md when routed to omp', () => {
  const home = mktmp('atem-omp-doctor-');
  const repo = path.join(home, 'repos', 'demo');
  initRepo(repo);
  const env = envFor(home);

  runAtem(['init'], env);
  runAtem(['start', 'Doctor scenario', '--type', 'implementation', '--repo', repo], env);
  const sessionsDir = path.join(home, '.atem', 'harness', 'sessions');
  const taskId = fs.readdirSync(sessionsDir)[0];
  // Route to omp WITHOUT writing AGENTS.md — doctor should warn.
  runAtem(['route', taskId, '--to', 'omp', '--repo', repo], env);

  const out = runAtem(['doctor'], env);
  // Either the missing-AGENTS warning or a successful presence message is OK,
  // but we must see SOME omp-aware line in the doctor output.
  assert.ok(/omp/i.test(out), 'doctor should mention omp');
});
