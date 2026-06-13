// Cross-platform "where is this binary on PATH" — `where` on Windows,
// `which` everywhere else. Returns the absolute path or null. Never throws.

const { execFileSync } = require('node:child_process');

function whichSync(name, { platform = process.platform } = {}) {
  const finder = platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // `where` may print multiple matches (one per line) — take the first.
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

module.exports = { whichSync };
