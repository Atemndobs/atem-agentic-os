const test = require('node:test');
const assert = require('node:assert/strict');
const { openInBrowser } = require('../src/cli.js');

function capture() {
  const calls = [];
  const spawnFn = (bin, args) => { calls.push({ bin, args }); return { unref() {} }; };
  return { calls, spawnFn };
}

test('openInBrowser uses the right launcher per platform', () => {
  const url = 'http://127.0.0.1:4400';

  let { calls, spawnFn } = capture();
  openInBrowser(url, { platform: 'darwin', spawnFn });
  assert.deepEqual(calls[0], { bin: 'open', args: [url] });

  ({ calls, spawnFn } = capture());
  openInBrowser(url, { platform: 'win32', spawnFn });
  assert.equal(calls[0].bin, 'cmd');
  assert.deepEqual(calls[0].args, ['/c', 'start', '""', url]);

  ({ calls, spawnFn } = capture());
  openInBrowser(url, { platform: 'linux', spawnFn });
  assert.deepEqual(calls[0], { bin: 'xdg-open', args: [url] });
});

test('openInBrowser never throws if the launcher is missing', () => {
  const spawnFn = () => { throw new Error('ENOENT'); };
  assert.equal(openInBrowser('http://x', { platform: 'win32', spawnFn }), false);
});
