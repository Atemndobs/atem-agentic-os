// dsh launcher tests.
//
// Dependency-injected spawnFn / existsFn / writeFileFn / env so we never spawn
// dsh or touch the real filesystem in CI. The full ACP round-trip is exercised
// by spikes/dsh-acp (needs a dsh checkout + Ollama), not here.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { makeDshLauncher, acpBinPath } = require('../src/launchers/dsh.js');
const { defaultRegistry, getLauncher } = require('../src/launchers/index.js');

function fakeChild(pid = 4242) {
  return { pid, unref() {} };
}

// existsFn stub: everything under `present` (a Set of absolute paths, plus a
// predicate for prefixes) exists; everything else does not.
function existsFrom(presentPaths) {
  const set = new Set(presentPaths);
  return (p) => set.has(p);
}

const REPO = '/fake/deepseek-harness';
const CONFIG = path.join(__dirname, '..', 'src', 'launchers', 'dsh-acp.config.yml');
const TARGET = '/fake/target-repo';

function baseEnv(over = {}) {
  return { ATEM_DSH_REPO: REPO, ATEM_DSH_ACP_CONFIG: CONFIG, ...over };
}

test('dsh launcher is registered under the "dsh" provider', () => {
  const reg = defaultRegistry();
  const l = getLauncher(reg, 'dsh');
  assert.equal(l.name, 'dsh');
});

test('available() true when repo, ACP bin, and config all exist', () => {
  const present = [REPO, acpBinPath(REPO), CONFIG];
  const l = makeDshLauncher({ existsFn: existsFrom(present), env: baseEnv() });
  assert.equal(l.available(), true);
});

test('available() false when the dsh repo is missing', () => {
  const present = [acpBinPath(REPO), CONFIG]; // repo dir itself absent
  const l = makeDshLauncher({ existsFn: existsFrom(present), env: baseEnv() });
  assert.equal(l.available(), false);
});

test('launch() returns unavailable when the config is missing', async () => {
  const present = [REPO, acpBinPath(REPO)]; // no config
  const l = makeDshLauncher({ existsFn: existsFrom(present), env: baseEnv() });
  const r = await l.launch({ syntheticId: 'x:1', targetRepo: TARGET });
  assert.equal(r.kind, 'unavailable');
  assert.match(r.reason, /config not found/);
});

test('launch() returns unavailable when targetRepo does not exist', async () => {
  const present = [REPO, acpBinPath(REPO), CONFIG]; // target absent
  const l = makeDshLauncher({ existsFn: existsFrom(present), env: baseEnv() });
  const r = await l.launch({ syntheticId: 'x:1', targetRepo: TARGET });
  assert.equal(r.kind, 'unavailable');
  assert.match(r.reason, /targetRepo/);
});

test('launch() spawns a detached runner and reports launched, feeding the handoff prompt as the seed', async () => {
  const present = [REPO, acpBinPath(REPO), CONFIG, TARGET];
  const outDir = os.tmpdir();
  const writes = [];
  const spawns = [];
  const l = makeDshLauncher({
    existsFn: existsFrom(present),
    writeFileFn: (f, data) => writes.push({ f, data }),
    spawnFn: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return fakeChild(9001); },
    env: baseEnv(),
  });

  const handoff = 'PICK UP: continue the auth refactor from state.md.';
  const r = await l.launch({
    syntheticId: 'claude-code:abc-123',
    targetRepo: TARGET,
    handoffPrompt: handoff,
    paths: { sessionDir: outDir },
  });

  assert.equal(r.kind, 'launched');
  assert.equal(r.metadata.transport, 'acp');
  assert.equal(r.metadata.workspace, TARGET);
  assert.equal(r.metadata.pid, 9001);

  // Spawned node against the detached runner, detached + unref'd.
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].cmd, 'node');
  assert.match(spawns[0].args[0], /dsh-acp-runner\.js$/);
  assert.equal(spawns[0].opts.detached, true);

  // Wrote an args file carrying the workspace and the handoff prompt as seed.
  assert.equal(writes.length, 1);
  const args = JSON.parse(writes[0].data);
  assert.equal(args.workspace, TARGET);
  assert.equal(args.seed, handoff);
  assert.equal(args.dshRepo, REPO);
  assert.equal(args.env.OLLAMA_API_KEY, 'ollama'); // dummy default supplied
});

test('launch() falls back to a self-contained seed when no handoff prompt is given', async () => {
  const present = [REPO, acpBinPath(REPO), CONFIG, TARGET];
  const writes = [];
  const l = makeDshLauncher({
    existsFn: existsFrom(present),
    writeFileFn: (f, data) => writes.push({ f, data }),
    spawnFn: () => fakeChild(),
    env: baseEnv(),
  });
  await l.launch({ syntheticId: 'omp:z', targetRepo: TARGET, paths: { sessionDir: os.tmpdir() } });
  const args = JSON.parse(writes[0].data);
  assert.match(args.seed, /Pick up the ATEM handoff for omp:z/);
  assert.match(args.seed, /Read AGENTS\.md/);
});
