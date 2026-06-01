const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI_PATH = path.resolve(__dirname, '../bin/atem.js');

function setupRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atem-goals-'));
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  return repoDir;
}

function run(repoDir, args) {
  return execFileSync('node', [CLI_PATH, ...args], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ATEM_HARNESS_MODE: 'repo',
    },
  });
}

test('goals reports drift from repo docs and writes a report file', () => {
  const repoDir = setupRepo();
  run(repoDir, ['init']);
  run(repoDir, ['start', 'Implement auth flow for owner portal', '--type', 'implementation']);

  fs.writeFileSync(
    path.join(repoDir, 'README.md'),
    [
      '# Project',
      '',
      '## Goals',
      '- [ ] Implement auth flow for owner portal',
      '- [ ] Add CSV export for invoices',
      '',
    ].join('\n'),
    'utf8'
  );

  const output = run(repoDir, ['goals']);

  assert.match(output, /ATEM goals/);
  assert.match(output, /Goal docs scanned: 1/);
  assert.match(output, /Goals found: 2/);
  assert.match(output, /Active tasks: 1/);
  assert.match(output, /Untracked goals: 1/);
  assert.match(output, /Active tasks without goal match: 0/);

  const reportDir = path.join(repoDir, '.harness', 'goals');
  const files = fs.readdirSync(reportDir).filter((name) => name.endsWith('-latest.md'));
  assert.equal(files.length, 1);

  const report = fs.readFileSync(path.join(reportDir, files[0]), 'utf8');
  assert.match(report, /## Untracked Goals/);
  assert.match(report, /Add CSV export for invoices/);
  assert.match(report, /suggested: atem start/);
});

