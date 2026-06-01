// Phase 2 tests: atem:// URL resolver, CLI surface, handle farm,
// adapter url-based read/write with optional hash anchoring.

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

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}

function envFor(home) {
  return {
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: '1',
    ATEM_HANDLES_DIR: path.join(home, '.atem', 'handles'),
  };
}

function runAtem(args, env) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function setupTask() {
  const home = mktmp('atem-url-');
  const repo = path.join(home, 'repos', 'demo');
  initRepo(repo);
  const env = envFor(home);
  runAtem(['init'], env);
  runAtem(['start', 'URL scheme exercise', '--type', 'implementation', '--repo', repo], env);
  const sessionsDir = path.join(home, '.atem', 'harness', 'sessions');
  const taskId = fs.readdirSync(sessionsDir)[0];
  return { home, repo, env, taskId, sessionsDir };
}

test('url resolver: aliases for known artifacts', () => {
  const { home, env, taskId, sessionsDir } = setupTask();
  const out = runAtem(['resolve', `atem://${taskId}/state`], env).trim();
  assert.equal(out, path.join(sessionsDir, taskId, 'state.md'));
  const outHandoff = runAtem(['resolve', `atem://${taskId}/handoff`], env).trim();
  assert.equal(outHandoff, path.join(sessionsDir, taskId, 'handoff.md'));
});

test('url resolver: atem://current routes to the active task', () => {
  const { env, taskId, sessionsDir } = setupTask();
  const out = runAtem(['resolve', 'atem://current/state'], env).trim();
  assert.equal(out, path.join(sessionsDir, taskId, 'state.md'));
});

test('url resolver: atem://list returns JSON of sessions', () => {
  const { env, taskId } = setupTask();
  const out = runAtem(['resolve', 'atem://list'], env);
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed.sessions));
  assert.ok(parsed.sessions.includes(taskId));
});

test('url resolver: rejects path traversal in task id', () => {
  const { env } = setupTask();
  assert.throws(
    () => runAtem(['resolve', 'atem://../etc/passwd'], env),
    /path-traversal|unsafe/i,
  );
});

test('url resolver: unknown artifact returns a clear error', () => {
  const { env, taskId } = setupTask();
  assert.throws(
    () => runAtem(['resolve', `atem://${taskId}/nonsense`], env),
    /unknown-artifact|unknown artifact/i,
  );
});

test('handles farm: symlinks land under ~/.atem/handles/<task>/*.md', () => {
  const { home, env, taskId, sessionsDir } = setupTask();
  // start already triggered syncHandlesQuietly; confirm.
  const handleDir = path.join(home, '.atem', 'handles', taskId);
  assert.ok(fs.existsSync(handleDir), `handle dir should exist: ${handleDir}`);
  for (const name of ['brief.md', 'state.md', 'handoff.md', 'next.md', 'decisions.md', 'validation.md', 'log.md']) {
    const link = path.join(handleDir, name);
    if (!fs.existsSync(link)) continue; // some artifacts created lazily
    const target = fs.readlinkSync(link);
    assert.equal(target, path.join(sessionsDir, taskId, name), `${name} should link to session file`);
  }
  // current symlink
  const cur = path.join(home, '.atem', 'handles', 'current');
  assert.ok(fs.existsSync(cur));
  assert.equal(fs.readlinkSync(cur), handleDir);
});

test('handles farm: atem url sync rebuilds the farm', () => {
  const { home, env, taskId } = setupTask();
  // Nuke the farm; sync should recreate.
  fs.rmSync(path.join(home, '.atem', 'handles'), { recursive: true, force: true });
  runAtem(['url', 'sync'], env);
  assert.ok(fs.existsSync(path.join(home, '.atem', 'handles', taskId)));
});

test('adapter: readUrl returns content + hash', () => {
  const { env, taskId } = setupTask();
  // We exercise the adapter as a library, in-process, using the same env.
  const prev = process.env.HOME;
  process.env.HOME = env.HOME;
  process.env.USERPROFILE = env.USERPROFILE;
  try {
    delete require.cache[require.resolve('../src/cli.js')];
    delete require.cache[require.resolve('../src/url.js')];
    delete require.cache[require.resolve('../src/handles.js')];
    delete require.cache[require.resolve('../src/adapters/index.js')];
    delete require.cache[require.resolve('../src/adapters/session.js')];
    const { adapters } = require('../src/adapters/index.js');
    const { resolveActivePaths, findGitRoot } = require('../src/cli.js');
    const paths = resolveActivePaths(findGitRoot(env.HOME));
    const adapter = adapters['claude-code'];
    const result = adapter.readUrl(`atem://${taskId}/state`, paths);
    assert.equal(result.kind, 'file');
    assert.ok(typeof result.content === 'string' && result.content.length > 0);
    assert.equal(result.hash.length, 64, 'sha256 hex');
  } finally {
    process.env.HOME = prev;
    process.env.USERPROFILE = prev;
  }
});

test('adapter: writeUrl honors hash-anchored writes', () => {
  const { env, taskId, sessionsDir } = setupTask();
  const prev = process.env.HOME;
  process.env.HOME = env.HOME;
  process.env.USERPROFILE = env.USERPROFILE;
  try {
    delete require.cache[require.resolve('../src/cli.js')];
    delete require.cache[require.resolve('../src/url.js')];
    delete require.cache[require.resolve('../src/handles.js')];
    delete require.cache[require.resolve('../src/adapters/index.js')];
    delete require.cache[require.resolve('../src/adapters/session.js')];
    const { adapters, hashContent } = require('../src/adapters/index.js');
    const { resolveActivePaths, findGitRoot } = require('../src/cli.js');
    const paths = resolveActivePaths(findGitRoot(env.HOME));
    const adapter = adapters['claude-code'];
    const url = `atem://${taskId}/state`;

    const initial = adapter.readUrl(url, paths);
    // Mutate file behind the adapter's back.
    fs.writeFileSync(path.join(sessionsDir, taskId, 'state.md'), initial.content + '\n# tamper\n');
    // Write with the stale hash should be rejected.
    assert.throws(
      () => adapter.writeUrl(url, initial.content + '\n# attempt\n', paths, { expectedHash: initial.hash }),
      /stale|stale-anchor/i,
    );
    // Without expectedHash, write succeeds.
    const result = adapter.writeUrl(url, '# rewritten\n', paths);
    assert.equal(result.hash, hashContent('# rewritten\n'));
    assert.equal(fs.readFileSync(path.join(sessionsDir, taskId, 'state.md'), 'utf8'), '# rewritten\n');
  } finally {
    process.env.HOME = prev;
    process.env.USERPROFILE = prev;
  }
});

test('instructions output references atem:// URL scheme', () => {
  const { env } = setupTask();
  const out = runAtem(['instructions', 'claude-code'], env);
  assert.ok(out.includes('atem://current/handoff'));
  assert.ok(out.includes('atem://current/state'));
  assert.ok(out.includes('~/.atem/handles/current'));
});
