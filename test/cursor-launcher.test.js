// G.1.3 — Cursor launcher tests.
//
// Dependency-injected `spawnFn` + `whichFn` + `writeRulesFn` so we
// don't actually spawn Cursor in CI. End-to-end behavior verified
// via stubs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const cursor = require('../src/launchers/cursor.js');

function mktmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

test('G.1.3: writes .cursorrules with the ATEM block on a clean repo', () => {
  const repo = mktmp('atem-cursor-launcher-clean-');
  const block = cursor.buildCursorRulesBlock({
    syntheticId: 'claude-code:abc-123',
    taskType: 'implementation',
    fromProvider: 'claude-code',
    targetRepo: repo,
  });
  const dest = cursor.writeCursorRules(repo, block);
  assert.equal(dest, path.join(repo, '.cursorrules'));
  const body = fs.readFileSync(dest, 'utf8');
  assert.match(body, /<!-- atem:cursorrules:begin -->/);
  assert.match(body, /<!-- atem:cursorrules:end -->/);
  assert.match(body, /claude-code:abc-123/);
  assert.match(body, /Repository boundary/);
});

test('G.1.3: replaces ONLY our marked block, preserves user-authored content', () => {
  const repo = mktmp('atem-cursor-launcher-merge-');
  fs.writeFileSync(
    path.join(repo, '.cursorrules'),
    '# Team rules\n\nKeep tests close to source.\n\n<!-- atem:cursorrules:begin -->\nOLD ATEM\n<!-- atem:cursorrules:end -->\n\nNo emojis in code.\n'
  );
  const block = cursor.buildCursorRulesBlock({
    syntheticId: 'sx', taskType: 'investigation', fromProvider: 'omp', targetRepo: repo,
  });
  cursor.writeCursorRules(repo, block);
  const body = fs.readFileSync(path.join(repo, '.cursorrules'), 'utf8');
  assert.ok(!/OLD ATEM/.test(body), 'old ATEM block replaced');
  assert.match(body, /Team rules/, 'user content preserved');
  assert.match(body, /Keep tests close to source/);
  assert.match(body, /No emojis in code/, 'trailing user content preserved');
  // Only one block survives
  const opens = body.match(/<!-- atem:cursorrules:begin -->/g) || [];
  assert.equal(opens.length, 1);
});

test('G.1.3: launcher.available() reflects PATH discovery', () => {
  const present = cursor.makeCursorLauncher({ whichFn: () => '/usr/local/bin/cursor' });
  assert.equal(present.available(), true);
  const missing = cursor.makeCursorLauncher({ whichFn: () => null });
  assert.equal(missing.available(), false);
});

test('G.1.3: launch() returns unavailable when targetRepo is missing', async () => {
  const launcher = cursor.makeCursorLauncher({ whichFn: () => '/fake/bin/cursor' });
  const r = await launcher.launch({ targetRepo: '/no/such/path' });
  assert.equal(r.kind, 'unavailable');
  assert.match(r.reason, /targetRepo/);
});

test('G.1.3: launch() spawns `cursor --reuse-window <repo>` and writes .cursorrules', async () => {
  const repo = mktmp('atem-cursor-launcher-spawn-');
  const spawnCalls = [];
  const fakeSpawn = (bin, args, opts) => {
    spawnCalls.push({ bin, args, opts });
    return Object.assign(new EventEmitter(), { unref() {}, pid: 4242 });
  };
  const launcher = cursor.makeCursorLauncher({
    whichFn: () => '/usr/local/bin/cursor',
    spawnFn: fakeSpawn,
  });
  const r = await launcher.launch({
    targetRepo: repo,
    syntheticId: 'claude-code:abc',
    taskType: 'implementation',
    fromProvider: 'claude-code',
  });
  assert.equal(r.kind, 'launched');
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, ['--reuse-window', repo]);
  assert.equal(spawnCalls[0].opts.detached, true);
  assert.ok(fs.existsSync(path.join(repo, '.cursorrules')), '.cursorrules created in repo');
});
