const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULTS, sanitize, loadConfig, saveConfig } = require('../src/web/config.js');

function tmpCfg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atem-web-cfg-'));
  return path.join(dir, 'web-config.json');
}

test('defaults show everything', () => {
  assert.equal(DEFAULTS.showTasks, true);
  assert.equal(DEFAULTS.showClaudeMemory, true);
  assert.deepEqual(DEFAULTS.hideFolders, []);
});

test('sanitize keeps known keys, drops unknown, coerces types', () => {
  const c = sanitize({ showExecuted: false, hideFolders: 'research, archive\nnode_modules', bogus: 'x', showTasks: 'nope' });
  assert.equal(c.showExecuted, false);
  assert.deepEqual(c.hideFolders, ['research', 'archive', 'node_modules']);
  assert.equal('bogus' in c, false);
  assert.equal(c.showTasks, true); // non-boolean ignored → default
});

test('sanitize accepts array lists and trims', () => {
  const c = sanitize({ hideFiles: ['  CHANGELOG ', '', 'LICENSE'] });
  assert.deepEqual(c.hideFiles, ['CHANGELOG', 'LICENSE']);
});

test('loadConfig returns defaults when file missing or invalid', () => {
  const p = tmpCfg();
  assert.deepEqual(loadConfig({ configPath: p }), DEFAULTS);
  fs.writeFileSync(p, 'not json');
  assert.deepEqual(loadConfig({ configPath: p }), DEFAULTS);
});

test('saveConfig writes sanitized config and loadConfig reads it back', () => {
  const p = tmpCfg();
  const saved = saveConfig({ configPath: p }, { showWorktrees: false, hideProjects: 'old', junk: 1 });
  assert.equal(saved.showWorktrees, false);
  assert.deepEqual(saved.hideProjects, ['old']);
  assert.equal('junk' in saved, false);
  const back = loadConfig({ configPath: p });
  assert.equal(back.showWorktrees, false);
  assert.deepEqual(back.hideProjects, ['old']);
  assert.equal(back.showTasks, true); // unspecified keys keep defaults
});
