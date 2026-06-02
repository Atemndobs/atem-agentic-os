// F.3 — atem install/uninstall tests.
//
// All synthetic file paths (no writes to real ~/.claude or ~/.codex).
// Covers JSON mcpServers shape, Codex TOML shape, idempotence, dry-run,
// uninstall, and the CLI dispatcher.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const installer = require('../src/installer.js');

function mktmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

const ENTRY = { command: '/usr/local/bin/atem', args: ['mcp-server'] };

// --- JSON shape ----------------------------------------------------------

test('F.3: installJsonMcp adds to a missing file', () => {
  const dir = mktmp('atem-install-json-');
  const file = path.join(dir, 'mcp.json');
  const r = installer.installJsonMcp(file, ENTRY);
  assert.equal(r.status, 'added');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(j.mcpServers.atem, ENTRY);
});

test('F.3: installJsonMcp preserves other mcpServers entries', () => {
  const dir = mktmp('atem-install-merge-');
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({
    mcpServers: {
      sqlite: { command: 'uvx', args: ['mcp-server-sqlite'] },
    },
    other_key: { keep: true },
  }, null, 2));
  installer.installJsonMcp(file, ENTRY);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(j.mcpServers.sqlite, 'pre-existing entry preserved');
  assert.ok(j.mcpServers.atem, 'atem entry added');
  assert.deepEqual(j.other_key, { keep: true }, 'unrelated top-level keys preserved');
});

test('F.3: installJsonMcp is idempotent on second run', () => {
  const dir = mktmp('atem-install-idem-');
  const file = path.join(dir, 'mcp.json');
  installer.installJsonMcp(file, ENTRY);
  const r2 = installer.installJsonMcp(file, ENTRY);
  assert.equal(r2.status, 'unchanged');
});

test('F.3: installJsonMcp updates a differing entry', () => {
  const dir = mktmp('atem-install-update-');
  const file = path.join(dir, 'mcp.json');
  installer.installJsonMcp(file, { command: '/old/atem', args: ['mcp-server'] });
  const r = installer.installJsonMcp(file, ENTRY);
  assert.equal(r.status, 'updated');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(j.mcpServers.atem.command, '/usr/local/bin/atem');
});

test('F.3: dry-run never writes', () => {
  const dir = mktmp('atem-install-dryrun-');
  const file = path.join(dir, 'mcp.json');
  const r = installer.installJsonMcp(file, ENTRY, { dryRun: true });
  assert.equal(r.status, 'would-add');
  assert.equal(fs.existsSync(file), false, 'file should not exist after dry run');
});

// --- Codex TOML ----------------------------------------------------------

test('F.3: installCodexToml appends a new block when file is empty', () => {
  const dir = mktmp('atem-install-toml-');
  const file = path.join(dir, 'config.toml');
  const r = installer.installCodexToml(file, ENTRY);
  assert.equal(r.status, 'added');
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /\[mcp_servers\.atem\]/);
  assert.match(body, /command = "\/usr\/local\/bin\/atem"/);
  assert.match(body, /enabled = true/);
});

test('F.3: installCodexToml preserves existing tables', () => {
  const dir = mktmp('atem-install-toml-preserve-');
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, `# Codex config
model = "gpt-5.5"

[mcp_servers.RepoPrompt]
command = "/Users/atem/RepoPrompt/repoprompt_cli"
enabled = false

[mcp_servers.granola]
url = "https://mcp.granola.ai/mcp"
`);
  installer.installCodexToml(file, ENTRY);
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /\[mcp_servers\.RepoPrompt\]/, 'existing entry preserved');
  assert.match(body, /\[mcp_servers\.granola\]/, 'existing entry preserved');
  assert.match(body, /\[mcp_servers\.atem\]/, 'atem added');
  assert.match(body, /model = "gpt-5.5"/, 'top-level value preserved');
});

test('F.3: installCodexToml idempotent — second run unchanged', () => {
  const dir = mktmp('atem-install-toml-idem-');
  const file = path.join(dir, 'config.toml');
  installer.installCodexToml(file, ENTRY);
  const r = installer.installCodexToml(file, ENTRY);
  assert.equal(r.status, 'unchanged');
});

test('F.3: installCodexToml updates when entry differs', () => {
  const dir = mktmp('atem-install-toml-update-');
  const file = path.join(dir, 'config.toml');
  installer.installCodexToml(file, { command: '/old', args: ['mcp-server'] });
  const r = installer.installCodexToml(file, ENTRY);
  assert.equal(r.status, 'updated');
  const body = fs.readFileSync(file, 'utf8');
  // Only one atem block survives
  const matches = body.match(/\[mcp_servers\.atem\]/g) || [];
  assert.equal(matches.length, 1);
  assert.match(body, /command = "\/usr\/local\/bin\/atem"/);
});

// --- uninstall -----------------------------------------------------------

test('F.3: uninstallJson removes the atem entry, keeps others', () => {
  const dir = mktmp('atem-uninstall-json-');
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({
    mcpServers: {
      atem: ENTRY,
      sqlite: { command: 'uvx', args: ['mcp-server-sqlite'] },
    },
  }, null, 2));
  const r = installer.uninstallJson(file);
  assert.equal(r.status, 'removed');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(j.mcpServers.atem, undefined);
  assert.ok(j.mcpServers.sqlite, 'sibling entry preserved');
});

test('F.3: uninstallCodexToml strips the atem block only', () => {
  const dir = mktmp('atem-uninstall-toml-');
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, `[mcp_servers.atem]
command = "atem"
args = ["mcp-server"]

[mcp_servers.granola]
url = "https://mcp.granola.ai/mcp"
`);
  const r = installer.uninstallCodexToml(file);
  assert.equal(r.status, 'removed');
  const body = fs.readFileSync(file, 'utf8');
  assert.ok(!/\[mcp_servers\.atem\]/.test(body));
  assert.match(body, /\[mcp_servers\.granola\]/);
});

// --- CLI dispatch --------------------------------------------------------

const CLI = path.join(__dirname, '..', 'bin', 'atem.js');
function runAtem(args, env, cwd) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env, NO_COLOR: '1' },
    cwd: cwd || env.HOME, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// --- F.4: Claude Code skill ---------------------------------------------

test('F.4: installClaudeCodeSkill copies SKILL.md from dist/ into ~/.claude/skills/', () => {
  const fakeHome = mktmp('atem-skill-install-');
  const realHome = os.homedir();
  // Point HOME at the temp dir so expandHome resolves there.
  process.env.HOME = fakeHome;
  try {
    const r = installer.installClaudeCodeSkill({});
    assert.equal(r.status, 'added');
    assert.ok(r.path.startsWith(fakeHome));
    const body = fs.readFileSync(r.path, 'utf8');
    assert.match(body, /name: atem-handoff/);
    assert.match(body, /Hand off the current coding session/);
  } finally {
    process.env.HOME = realHome;
  }
});

test('F.4: installClaudeCodeSkill is idempotent on second run', () => {
  const fakeHome = mktmp('atem-skill-idem-');
  const realHome = os.homedir();
  process.env.HOME = fakeHome;
  try {
    installer.installClaudeCodeSkill({});
    const r = installer.installClaudeCodeSkill({});
    assert.equal(r.status, 'unchanged');
  } finally {
    process.env.HOME = realHome;
  }
});

test('F.4: --with-skill triggers the skill writer when installing claude-code', () => {
  const fakeHome = mktmp('atem-skill-flag-');
  const realHome = os.homedir();
  process.env.HOME = fakeHome;
  try {
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    const r = installer.installProvider('claude-code', { withSkill: true });
    assert.ok(r.skill, 'skill result included');
    assert.equal(r.skill.status, 'added');
    assert.ok(fs.existsSync(path.join(fakeHome, '.claude', 'skills', 'atem-handoff', 'SKILL.md')));
  } finally {
    process.env.HOME = realHome;
  }
});

test('F.3: atem install --list prints the provider table', () => {
  const home = mktmp('atem-install-list-');
  const out = runAtem(['install', '--list'], { HOME: home });
  assert.match(out, /Provider/);
  assert.match(out, /claude-code/);
  assert.match(out, /codex/);
  assert.match(out, /cursor/);
});

test('F.3: atem install <provider> --dry-run does not touch the filesystem', () => {
  const home = mktmp('atem-install-dryrun-cli-');
  // Pre-create a claude-code config dir so detect() passes
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const cfgFile = path.join(home, '.claude', 'mcp.json');
  assert.equal(fs.existsSync(cfgFile), false);
  const out = runAtem(['install', 'claude-code', '--dry-run'], { HOME: home });
  assert.match(out, /would add|would update/);
  assert.equal(fs.existsSync(cfgFile), false, 'dry-run must not write');
});
