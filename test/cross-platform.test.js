const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { whichSync } = require('../src/which.js');
const { ensureSymlink } = require('../src/handles.js');

test('whichSync finds a real binary and is null for a missing one', () => {
  // node is guaranteed on PATH wherever the test runs.
  assert.ok(whichSync('node'), 'node should resolve');
  assert.equal(whichSync('definitely-not-a-real-binary-zzz'), null);
});

test('whichSync never throws, even with a bogus platform/finder', () => {
  // Forcing win32 on a POSIX box runs `where`, which is absent → null, no throw.
  assert.doesNotThrow(() => whichSync('node', { platform: 'win32' }));
});

test('ensureSymlink creates a working symlink (POSIX path)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atem-link-'));
  const target = path.join(dir, 'target.md');
  const link = path.join(dir, 'link.md');
  fs.writeFileSync(target, 'hello');
  ensureSymlink(target, link);
  assert.equal(fs.readFileSync(link, 'utf8'), 'hello');
});

test('ensureSymlink falls back to a hard link when symlink is denied (Windows path)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atem-link-eperm-'));
  const target = path.join(dir, 'target.md');
  const link = path.join(dir, 'link.md');
  fs.writeFileSync(target, 'live-content');

  // Simulate Windows-without-privilege: symlinkSync throws EPERM.
  const realSymlink = fs.symlinkSync;
  fs.symlinkSync = () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; };
  try {
    ensureSymlink(target, link);
  } finally {
    fs.symlinkSync = realSymlink;
  }

  // The link exists, reads the content, and shares the inode (hard link → live).
  assert.equal(fs.readFileSync(link, 'utf8'), 'live-content');
  assert.equal(fs.statSync(link).ino, fs.statSync(target).ino, 'hard link shares inode (stays live)');

  // Editing the canonical file shows through the hard link.
  fs.writeFileSync(target, 'updated');
  assert.equal(fs.readFileSync(link, 'utf8'), 'updated');
});
