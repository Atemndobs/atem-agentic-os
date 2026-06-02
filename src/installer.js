// F.3 — `atem install <provider>` writes the MCP config entry for ATEM
// into each provider's expected location. Idempotent.
//
// Supported providers (by config-file shape):
//   claude-desktop  — Anthropic Desktop app
//                     ~/Library/Application Support/Claude/claude_desktop_config.json
//   claude-code     — Claude Code CLI ~/.claude/mcp.json
//   cursor          — ~/.cursor/mcp.json (global) or .cursor/mcp.json (per-project)
//   codex           — ~/.codex/config.toml ([mcp_servers.atem] table)
//   opencode        — ~/.opencode/mcp.json (best-effort)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Resolve the absolute path to the `atem` binary the user is running.
// Prefer the literal entry point so `atem install` from a checkout
// configures the right local build, not a system-installed copy.
function resolveAtemCommand() {
  return process.env.ATEM_BIN_OVERRIDE || process.argv[1] || 'atem';
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function defaultMcpEntry() {
  const bin = resolveAtemCommand();
  // For Node CLI entry points we explicitly invoke via node so the
  // entry works regardless of shebang or PATH. If the user pinned
  // `atem` on PATH they can edit the entry by hand.
  if (bin.endsWith('.js')) {
    return { command: 'node', args: [bin, 'mcp-server'] };
  }
  return { command: bin, args: ['mcp-server'] };
}

// ---- target descriptors -------------------------------------------------

const TARGETS = {
  'claude-desktop': {
    label: 'Claude Desktop',
    paths: ['~/Library/Application Support/Claude/claude_desktop_config.json'],
    kind: 'json-mcpServers',
    detect: () => fs.existsSync(expandHome('~/Library/Application Support/Claude')),
  },
  'claude-code': {
    label: 'Claude Code (CLI)',
    paths: ['~/.claude/mcp.json'],
    kind: 'json-mcpServers',
    detect: () => fs.existsSync(expandHome('~/.claude')),
  },
  cursor: {
    label: 'Cursor',
    paths: ['~/.cursor/mcp.json'],
    perProjectPath: '.cursor/mcp.json',
    kind: 'json-mcpServers',
    detect: () => fs.existsSync(expandHome('~/.cursor')),
  },
  codex: {
    label: 'Codex',
    paths: ['~/.codex/config.toml'],
    kind: 'toml-mcp_servers',
    detect: () => fs.existsSync(expandHome('~/.codex')),
  },
  opencode: {
    label: 'OpenCode',
    paths: ['~/.opencode/mcp.json', '~/.opencode/config.json'],
    kind: 'json-mcpServers',
    detect: () => fs.existsSync(expandHome('~/.opencode')),
  },
};

const SERVER_NAME = 'atem';

// ---- JSON-mcpServers writer ---------------------------------------------

function readJsonOrEmpty(file) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    if (!content.trim()) return {};
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.atem-install-tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function installJsonMcp(file, entry, { dryRun = false } = {}) {
  const expanded = expandHome(file);
  const existing = readJsonOrEmpty(expanded);
  if (!existing.mcpServers || typeof existing.mcpServers !== 'object') {
    existing.mcpServers = {};
  }
  const before = existing.mcpServers[SERVER_NAME];
  const desired = entry;
  if (
    before &&
    before.command === desired.command &&
    JSON.stringify(before.args || []) === JSON.stringify(desired.args || [])
  ) {
    return { status: 'unchanged', path: expanded };
  }
  existing.mcpServers[SERVER_NAME] = desired;
  if (dryRun) {
    return { status: before ? 'would-update' : 'would-add', path: expanded };
  }
  writeJsonAtomic(expanded, existing);
  return { status: before ? 'updated' : 'added', path: expanded };
}

// ---- Codex TOML writer --------------------------------------------------
//
// We avoid pulling in a TOML library by doing a structural string-edit:
//   - If [mcp_servers.atem] already exists with matching command + args
//     → no-op.
//   - If it exists but differs → replace the whole block in place.
//   - If it's absent → append the block at the end.
// The Codex config.toml is human-edited; we keep our footprint tight.

function buildCodexBlock(entry) {
  const lines = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${JSON.stringify(entry.command)}`,
    `args = ${JSON.stringify(entry.args || [])}`,
    `enabled = true`,
  ];
  return lines.join('\n') + '\n';
}

// Find the [mcp_servers.atem] block by scanning line-by-line: the
// block starts at the header line and extends until the next line
// that starts a new top-level table ('['), or EOF. Returns absolute
// byte offsets [start, end) within `content`.
function findCodexBlock(content) {
  const header = `[mcp_servers.${SERVER_NAME}]`;
  const lines = content.split('\n');
  let start = -1;
  let offset = 0;
  const offsets = [];
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1; // +1 for \n
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === header) { start = i; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('[')) { end = i; break; }
  }
  const startByte = offsets[start];
  // End offset is start of the next section (or EOF); trim trailing
  // blank lines so we don't accumulate blank gaps.
  let endByte = end < lines.length ? offsets[end] : content.length;
  // Strip trailing newlines/blanks belonging to our block.
  while (endByte > startByte && /\s/.test(content[endByte - 1])) endByte -= 1;
  // Re-include the trailing newline if present so the section ends cleanly.
  if (endByte < content.length && content[endByte] === '\n') endByte += 1;
  return { start: startByte, end: endByte };
}

function installCodexToml(file, entry, { dryRun = false } = {}) {
  const expanded = expandHome(file);
  let content = '';
  try { content = fs.readFileSync(expanded, 'utf8'); } catch { /* may not exist */ }
  const block = buildCodexBlock(entry);
  const found = findCodexBlock(content);
  let next;
  if (found) {
    const current = content.slice(found.start, found.end);
    if (current.trim() === block.trim()) {
      return { status: 'unchanged', path: expanded };
    }
    next = content.slice(0, found.start) + block + content.slice(found.end);
  } else {
    next = (content.endsWith('\n') || content === '') ? content + block : content + '\n' + block;
  }
  if (dryRun) {
    return { status: found ? 'would-update' : 'would-add', path: expanded };
  }
  fs.mkdirSync(path.dirname(expanded), { recursive: true });
  const tmp = expanded + '.atem-install-tmp';
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, expanded);
  return { status: found ? 'updated' : 'added', path: expanded };
}

// ---- uninstall ----------------------------------------------------------

function uninstallJson(file) {
  const expanded = expandHome(file);
  if (!fs.existsSync(expanded)) return { status: 'absent', path: expanded };
  const data = readJsonOrEmpty(expanded);
  if (!data.mcpServers || !data.mcpServers[SERVER_NAME]) {
    return { status: 'absent', path: expanded };
  }
  delete data.mcpServers[SERVER_NAME];
  writeJsonAtomic(expanded, data);
  return { status: 'removed', path: expanded };
}

function uninstallCodexToml(file) {
  const expanded = expandHome(file);
  if (!fs.existsSync(expanded)) return { status: 'absent', path: expanded };
  const content = fs.readFileSync(expanded, 'utf8');
  const found = findCodexBlock(content);
  if (!found) return { status: 'absent', path: expanded };
  const next = (content.slice(0, found.start) + content.slice(found.end)).replace(/\n{3,}/g, '\n\n');
  const tmp = expanded + '.atem-install-tmp';
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, expanded);
  return { status: 'removed', path: expanded };
}

// ---- top-level orchestration --------------------------------------------

function installProvider(name, { dryRun = false, perProject = false, withSkill = false, entry, file: explicitFile } = {}) {
  const target = TARGETS[name];
  if (!target) throw new Error(`Unknown provider for install: ${name}`);
  const mcpEntry = entry || defaultMcpEntry();
  let file = explicitFile;
  if (!file) {
    if (perProject && target.perProjectPath) {
      file = path.join(process.cwd(), target.perProjectPath);
    } else {
      file = target.paths[0];
    }
  }
  let result;
  if (target.kind === 'json-mcpServers') {
    result = { provider: name, label: target.label, ...installJsonMcp(file, mcpEntry, { dryRun }) };
  } else if (target.kind === 'toml-mcp_servers') {
    result = { provider: name, label: target.label, ...installCodexToml(file, mcpEntry, { dryRun }) };
  } else {
    throw new Error(`Unsupported target kind: ${target.kind}`);
  }
  // F.4: --with-skill installs the bundled SKILL.md for providers that
  // have a known skills directory. Currently: claude-code.
  if (withSkill && name === 'claude-code') {
    const skillResult = installClaudeCodeSkill({ dryRun });
    result.skill = skillResult;
  }
  return result;
}

function installClaudeCodeSkill({ dryRun = false } = {}) {
  const source = path.join(__dirname, '..', 'dist', 'skills', 'claude-code', 'handoff', 'SKILL.md');
  const targetDir = expandHome('~/.claude/skills/atem-handoff');
  const target = path.join(targetDir, 'SKILL.md');
  if (!fs.existsSync(source)) return { status: 'missing-source', path: source };
  let before = '';
  try { before = fs.readFileSync(target, 'utf8'); } catch { /* not present */ }
  const desired = fs.readFileSync(source, 'utf8');
  if (before === desired) return { status: 'unchanged', path: target };
  if (dryRun) return { status: before ? 'would-update' : 'would-add', path: target };
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(target, desired);
  return { status: before ? 'updated' : 'added', path: target };
}

function uninstallProvider(name) {
  const target = TARGETS[name];
  if (!target) throw new Error(`Unknown provider: ${name}`);
  const file = target.paths[0];
  if (target.kind === 'json-mcpServers') {
    return { provider: name, label: target.label, ...uninstallJson(file) };
  }
  if (target.kind === 'toml-mcp_servers') {
    return { provider: name, label: target.label, ...uninstallCodexToml(file) };
  }
  throw new Error(`Unsupported target kind: ${target.kind}`);
}

function detectedProviders() {
  return Object.entries(TARGETS)
    .filter(([, t]) => t.detect())
    .map(([k]) => k);
}

function listProviders() {
  return Object.entries(TARGETS).map(([k, t]) => ({
    name: k,
    label: t.label,
    detected: t.detect(),
    paths: t.paths,
  }));
}

module.exports = {
  TARGETS,
  SERVER_NAME,
  defaultMcpEntry,
  installProvider,
  uninstallProvider,
  detectedProviders,
  listProviders,
  // Exposed for tests
  installJsonMcp,
  installCodexToml,
  installClaudeCodeSkill,
  uninstallJson,
  uninstallCodexToml,
  expandHome,
  findCodexBlock,
};
