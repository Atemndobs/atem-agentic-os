const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync, execFileSync, spawn } = require('node:child_process');

const PRODUCT_NAME = 'ATEM';
// ATEM = Agent Task Execution Mesh.
// See docs/decisions/001-atem-naming.md for the rationale.
const PRODUCT_TAGLINE = 'Agent Task Execution Mesh — session handoff for AI coding agents.';
const GLOBAL_STATE_DIR = path.join(os.homedir(), '.atem', 'harness');

const synthetic = require('./synthetic.js');

// Lazy require to avoid a require-cycle (src/url.js / src/handles.js have
// no dependency on cli.js, but we keep the load lazy so test-only paths
// remain cheap).
let _handles = null;
function handlesModule() {
  if (!_handles) _handles = require('./handles.js');
  return _handles;
}
function syncHandlesQuietly(paths) {
  try { handlesModule().syncAll(paths); } catch { /* best effort — never block CLI on this */ }
}

const PROVIDERS = new Set([
  'cursor',
  'claude-code',
  'codex',
  'opencode',
  'openrouter',
  'omp',
  'antigravity',
  'local-model',
  'manual',
]);

const TASK_TYPES = new Set([
  'tracker',
  'implementation',
  'investigation',
  'validation',
  'documentation',
  'review',
]);

const DEFAULT_TASK_TYPE = 'implementation';
const PROJECT_REQUIRED_FILES = [
  'project-rules.md',
  'agent-roles.md',
  'worktrees.md',
  'integration-queue.md',
];
const GOAL_DOC_CANDIDATES = [
  'README.md',
  'TASKS.md',
  'TODO.md',
  'docs/goals.md',
  'docs/roadmap.md',
  'docs/todo.md',
  'docs/backlog.md',
];

const USE_COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};
function paint(text, color) {
  if (!USE_COLOR || !color) return text;
  const code = ANSI[color];
  return code ? `${code}${text}${ANSI.reset}` : text;
}
// Strip ANSI for width calculations.
function visibleLength(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
}

const ICONS = {
  ok: '✓',
  warn: '⚠',
  fail: '✗',
  fix: '🔧',
  skip: '⏭',
  archive: '📦',
  trash: '🗑',
  provider: '◆',
  none: '·',
  task: '▸',
  repo: '📁',
  missing: '✗',
};

function levelBadge(level) {
  switch (level) {
    case 'OK':   return `${ICONS.ok} ${paint('[OK]', 'green')}`;
    case 'WARN': return `${ICONS.warn} ${paint('[WARN]', 'yellow')}`;
    case 'FAIL': return `${ICONS.fail} ${paint('[FAIL]', 'red')}`;
    default:     return paint(`[${level}]`, 'gray');
  }
}

function renderTable(headers, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const cols = headers.length;
  const stringRows = rows.map((r) => r.map((c) => (c === undefined || c === null ? '' : String(c))));
  const widths = headers.map((h, i) => {
    let w = visibleLength(h);
    for (const r of stringRows) {
      const cell = r[i] || '';
      for (const line of cell.split('\n')) {
        const vl = visibleLength(line);
        if (vl > w) w = vl;
      }
    }
    return w;
  });
  const sep = USE_COLOR ? paint('│', 'gray') : '│';
  const top = paint('┌' + widths.map((w) => '─'.repeat(w + 2)).join('┬') + '┐', 'gray');
  const mid = paint('├' + widths.map((w) => '─'.repeat(w + 2)).join('┼') + '┤', 'gray');
  const bot = paint('└' + widths.map((w) => '─'.repeat(w + 2)).join('┴') + '┘', 'gray');
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - visibleLength(s)));
  const renderRow = (cells) => {
    // support multi-line cells
    const split = cells.map((c) => (c || '').split('\n'));
    const height = Math.max(...split.map((s) => s.length));
    const lines = [];
    for (let h = 0; h < height; h += 1) {
      const parts = split.map((s, i) => pad(s[h] || '', widths[i]));
      lines.push(`${sep} ` + parts.join(` ${sep} `) + ` ${sep}`);
    }
    return lines.join('\n');
  };
  const styledHeaders = headers.map((h) => paint(String(h), 'bold'));
  const header = `${sep} ` + styledHeaders.map((h, i) => pad(h, widths[i])).join(` ${sep} `) + ` ${sep}`;
  const body = stringRows.map((r) => renderRow(r.slice(0, cols))).join('\n');
  return [top, header, mid, body, bot].join('\n');
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function snapshotStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function findGitRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  while (true) {
    const gitPath = path.join(current, '.git');
    if (fs.existsSync(gitPath)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function getRepoPaths(gitRoot) {
  const harnessDir = path.join(gitRoot, '.harness');
  const sessionsDir = path.join(harnessDir, 'sessions');
  return {
    mode: 'repo',
    repoRoot: gitRoot,
    harnessDir,
    sessionsDir,
    currentSessionFile: path.join(harnessDir, 'current-session.md'),
    routingFile: path.join(harnessDir, 'routing.md'),
    providerContractFile: path.join(harnessDir, 'provider-contract.md'),
  };
}

function getGlobalPaths() {
  const harnessDir = GLOBAL_STATE_DIR;
  const sessionsDir = path.join(harnessDir, 'sessions');
  return {
    mode: 'global',
    repoRoot: null,
    harnessDir,
    sessionsDir,
    currentSessionFile: path.join(harnessDir, 'current-session.md'),
    routingFile: path.join(harnessDir, 'routing.md'),
    providerContractFile: path.join(harnessDir, 'provider-contract.md'),
  };
}

function resolveActivePaths(gitRoot) {
  const explicitRepoMode = process.env.ATEM_HARNESS_MODE === 'repo';
  if (explicitRepoMode && gitRoot) {
    return getRepoPaths(gitRoot);
  }
  return getGlobalPaths();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureFile(filePath, content) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeFile(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

function shellQuote(value) {
  return `'${`${value}`.replace(/'/g, `'\\''`)}'`;
}

function sectionRegex(name) {
  // Use absolute end-of-input, not multiline "$", to avoid partial section
  // matches that can duplicate content when repeatedly updating a section.
  return new RegExp(`(^## ${escapeRegex(name)}\\n)([\\s\\S]*?)(?=\\n## |(?![\\s\\S]))`, 'm');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSection(content, sectionName) {
  const match = content.match(sectionRegex(sectionName));
  if (!match) return '';
  return match[2].trim();
}

function setSection(content, sectionName, value) {
  const normalizedValue = `${value}`.trimEnd();
  const regex = sectionRegex(sectionName);
  if (regex.test(content)) {
    return content.replace(regex, `$1${normalizedValue}\n`);
  }

  const separator = content.endsWith('\n') ? '' : '\n';
  return `${content}${separator}\n## ${sectionName}\n${normalizedValue}\n`;
}

function uniqueBy(items, toKey) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const key = toKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function uniqueStrings(items) {
  return uniqueBy(items.map((item) => `${item}`.trim()).filter(Boolean), (item) => item);
}

function removeDuplicateSectionBlocks(content, sectionName) {
  const headingPattern = new RegExp(`^## ${escapeRegex(sectionName)}$`, 'gm');
  const matches = Array.from(content.matchAll(headingPattern));
  if (matches.length <= 1) return content;

  let normalized = content;
  for (let i = matches.length - 1; i >= 1; i -= 1) {
    const start = matches[i].index;
    const nextHeading = normalized.indexOf('\n## ', start + 1);
    const end = nextHeading >= 0 ? nextHeading + 1 : normalized.length;
    normalized = normalized.slice(0, start) + normalized.slice(end);
  }

  return normalized;
}

function sectionCount(content, sectionName) {
  const headingPattern = new RegExp(`^## ${escapeRegex(sectionName)}$`, 'gm');
  return Array.from(content.matchAll(headingPattern)).length;
}

function appendLog(logContent, message) {
  return `${logContent.trimEnd()}\n\n## ${nowStamp()}\n- ${message}\n`;
}

function appendBulletSection(content, headingLevel, headingTitle, bulletLine) {
  const heading = `${headingLevel} ${headingTitle}`;
  if (!content.includes(heading)) {
    const separator = content.endsWith('\n') ? '' : '\n';
    return `${content}${separator}\n${heading}\n- ${bulletLine}\n`;
  }

  const regex = new RegExp(`(^${escapeRegex(heading)}\\n)([\\s\\S]*?)(?=\\n${escapeRegex(headingLevel)}\\s|$)`, 'm');
  return content.replace(regex, (_, prefix, body) => {
    const normalizedBody = body.trimEnd();
    return `${prefix}${normalizedBody}\n- ${bulletLine}\n`;
  });
}

function defaultCurrentSession() {
  return `# Current Session\n\n## Active Task ID\nNone\n\n## Current Provider\nmanual\n\n## Last Updated\n${nowStamp()}\n`;
}

function defaultRouting() {
  return `# Routing Policy\n\n## Provider Defaults\n\n| Task Type | Preferred Provider |\n|---|---|\n| Deep reasoning / architecture | claude-code |\n| Test-driven implementation | codex |\n| IDE-native edits | cursor |\n| Cheap/simple edits | opencode or openrouter |\n| Boilerplate/docs | openrouter or local-model |\n| Manual review | manual |\n\n## Rules\n\n- If tests must be run, prefer codex or claude-code.\n- If the task is mostly reasoning, prefer claude-code.\n- If the task is interactive editing inside the IDE, prefer cursor.\n- If the task is cheap and low risk, prefer opencode/openrouter/local-model.\n- If the task touches auth, security, payments, infrastructure, or migrations, require validation and human review.\n`;
}

function defaultProviderContract() {
  return `# ATEM Provider Contract\n\nATEM provides session handoff for AI coding agents, backed by Git-readable files.\n\n## Core Contract\n\nBefore working:\n1. Read the active session files.\n2. Respect the target repository boundary.\n3. Preserve existing decisions and scope.\n\nWhile working:\n1. Keep changes narrow.\n2. Record important decisions.\n3. Record validation commands and results.\n4. Do not rely on chat memory alone.\n\nBefore stopping:\n1. Update \`handoff.md\`.\n2. Update \`state.md\`.\n3. Update \`next.md\`.\n4. Update \`validation.md\`.\n5. Update \`decisions.md\` if decisions changed.\n6. Append a short entry to \`log.md\`.\n\nNever end a provider session without updating \`handoff.md\`.\n\n## Repository Boundary\nOnly work inside the target repository unless explicitly instructed otherwise.\nDo not modify sibling repositories, sibling worktrees, or unrelated checkouts.\n\n## Provider-Neutral Rule\nThis contract applies to:\n- Claude Code\n- Codex\n- Cursor\n- OpenCode\n- OpenRouter\n- local models\n- manual human sessions\n`;
}

function buildFrontmatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    lines.push(`${key}: ${value}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function syncStateFrontmatter(content, taskId) {
  const { data, body } = parseFrontmatter(content);
  const mirror = {
    task_id: taskId || data.task_id || '',
    task_type: getSection(content, 'Task Type') || data.task_type || '',
    status: getSection(content, 'Status') || data.status || 'active',
    provider: getSection(content, 'Current Provider') || data.provider || 'manual',
    repo: getSection(content, 'Primary Repository') || data.repo || '',
    target_repo: getSection(content, 'Target Repository') || data.target_repo || '',
    repos: data.repos || '',
    schema: 'atem.session.v1',
  };
  return buildFrontmatter(mirror) + body;
}

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return { data: {}, body: content };
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return { data: {}, body: content };
  const block = content.slice(4, end);
  const body = content.slice(end + 5);
  const data = {};
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) data[key] = val;
  }
  return { data, body };
}

function createSessionTemplates(taskId, title, options = {}) {
  const stamp = nowStamp();
  const taskType = normalizeTaskType(options.taskType || DEFAULT_TASK_TYPE);
  const primaryRepository = options.primaryRepository || 'unknown';
  const targetRepository = options.targetRepository || '';
  const targetRepoSection = targetRepository ? `\n## Target Repository\n${targetRepository}\n` : '';

  const briefFm = buildFrontmatter({
    task_id: taskId,
    task_type: taskType,
    schema: 'atem.session.v1',
  });
  const stateFm = buildFrontmatter({
    task_id: taskId,
    task_type: taskType,
    status: 'active',
    provider: 'manual',
    repo: primaryRepository,
    target_repo: targetRepository,
    schema: 'atem.session.v1',
  });

  return {
    'brief.md': `${briefFm}# Task Brief\n\n## Task ID\n${taskId}\n\n## Title\n${title}\n\n## Task Type\n${taskType}\n\n## Goal\n${title}\n\n## Scope\n- Make the smallest useful progress toward the goal.\n\n## Out of Scope\n- Unrelated refactors.\n\n## Constraints\n- Keep changes reviewable and local-first.\n`,
    'state.md': `${stateFm}# Session State\n\n## Status\nactive\n\n## Current Provider\nmanual\n\n## Task Type\n${taskType}\n\n## Current Summary\nTask started. No implementation yet.\n\n## Primary Repository\n${primaryRepository}${targetRepoSection}\n## Related Workspaces\nNone detected.\n\n## Files Touched\nNone yet.\n\n## Known Issues\nNone yet.\n\n## Last Updated\n${stamp}\n`,
    'handoff.md': `# Handoff\n\n## Task\n${taskId} - ${title}\n\n## Goal\n${title}\n\n## Current Status\nNo implementation yet.\n\n## What Was Done\nCreated session files.\n\n## Files Touched\nNone yet.\n\n## Decisions\nNone yet.\n\n## Validation\nNo validation run yet.\n\n## Next Recommended Action\nRead session files and start the smallest useful step.\n\n## Previous Provider\nNone\n\n## Next Suggested Provider\nmanual\n\n## Reason for Suggested Provider\nDefault start provider.\n`,
    'decisions.md': `# Decisions\n\n## Decision Log\n\n### ${stamp}\n- Decision: Session created.\n- Reason: Start task tracking.\n- Impact: Provider handoff can begin.\n`,
    'next.md': `# Next Actions\n\n1. Read the relevant project files.\n2. Identify the smallest useful change.\n3. Implement and validate that change.\n4. Update handoff.md before stopping.\n`,
    'validation.md': `# Validation\n\n## Commands Run\n\nNone yet.\n\n## Results\n\nNo validation run yet.\n\n## Known Failures\n\nNone yet.\n`,
    'log.md': `# Session Log\n\n## ${stamp}\n- Created ${taskId}.\n`,
  };
}

function parseStartArgs(args) {
  const titleParts = [];
  let taskType = '';
  let typeExplicit = false;
  let repo = '';

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--type') {
      const value = args[i + 1];
      if (!value) {
        throw new Error('Usage: atem start "<task title>" [--type <type>] [--repo <repo-path>]');
      }
      taskType = normalizeTaskType(value);
      typeExplicit = true;
      i += 1;
      continue;
    }
    if (token === '--repo') {
      const value = args[i + 1];
      if (!value) {
        throw new Error('Usage: atem start "<task title>" [--type <type>] [--repo <repo-path>]');
      }
      repo = path.resolve(value);
      i += 1;
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`Unknown flag for start: ${token}`);
    }
    titleParts.push(token);
  }

  const title = titleParts.join(' ').trim();
  if (!title) {
    throw new Error('Usage: atem start "<task title>" [--type <type>] [--repo <repo-path>]');
  }
  if (!taskType) {
    taskType = inferTaskTypeFromTitle(title);
  }
  if (!isValidTaskType(taskType)) {
    throw new Error(`Unknown task type: ${taskType}`);
  }

  return { title, taskType, repo, typeExplicit };
}

function parseStatusArgs(args) {
  let repoFilter = '';
  let showAll = false;
  let explicitRepo = false;
  let verbose = false;

  const usage = 'Usage: atem status [--repo <repo-path>] [--all] [--verbose|-v]';
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--repo') {
      const value = args[i + 1];
      if (!value) {
        throw new Error(usage);
      }
      repoFilter = path.resolve(value);
      explicitRepo = true;
      i += 1;
      continue;
    }
    if (token === '--all') {
      showAll = true;
      continue;
    }
    if (token === '--verbose' || token === '-v') {
      verbose = true;
      continue;
    }
    if (token.startsWith('--') || token.startsWith('-')) {
      throw new Error(`Unknown flag for status: ${token}`);
    }
    throw new Error(usage);
  }

  return { repoFilter, showAll, explicitRepo, verbose };
}

function parseGoalsArgs(args, gitRoot) {
  const usage = 'Usage: atem goals [--repo <repo-path>] [--files <a,b,c>] [--json]';
  let repoPath = gitRoot ? path.resolve(gitRoot) : '';
  let filesCsv = '';
  let asJson = false;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--repo') {
      const value = args[i + 1];
      if (!value) throw new Error(usage);
      repoPath = path.resolve(value);
      i += 1;
      continue;
    }
    if (token === '--files') {
      const value = args[i + 1];
      if (!value) throw new Error(usage);
      filesCsv = value;
      i += 1;
      continue;
    }
    if (token === '--json') {
      asJson = true;
      continue;
    }
    if (token.startsWith('--')) {
      throw new Error(`Unknown flag for goals: ${token}`);
    }
    throw new Error(usage);
  }

  if (!repoPath) {
    throw new Error(usage);
  }

  const explicitFiles = filesCsv
    ? filesCsv.split(',').map((item) => item.trim()).filter(Boolean)
    : [];

  return { repoPath, explicitFiles, asJson };
}

function initializeHarness(paths) {
  ensureDir(paths.harnessDir);
  ensureDir(paths.sessionsDir);
  ensureFile(paths.currentSessionFile, defaultCurrentSession());
  ensureFile(paths.routingFile, defaultRouting());
  ensureFile(paths.providerContractFile, defaultProviderContract());
}

function ensureHarnessReady(paths) {
  initializeHarness(paths);
}

function commandInit(gitRoot) {
  // Use the same mode resolution as every other command. Previously
  // init defaulted to repo-mode whenever it found a git root, while
  // start/status/doctor/etc. defaulted to global mode — so
  // `atem init && atem doctor` initialized one store and inspected
  // another. Make init follow ATEM_HARNESS_MODE like everything else.
  const paths = resolveActivePaths(gitRoot);
  initializeHarness(paths);
  if (paths.mode === 'repo') {
    console.log(`Initialized project handoff store: ${paths.harnessDir}`);
    return;
  }
  console.log(`Initialized global handoff store: ${paths.harnessDir}`);
}

function getNextTaskId(sessionsDir) {
  const entries = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir, { withFileTypes: true }) : [];
  let max = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^TASK-(\d+)$/);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isNaN(value) && value > max) {
      max = value;
    }
  }

  return `TASK-${String(max + 1).padStart(3, '0')}`;
}

function getSessionDir(paths, taskId) {
  return path.join(paths.sessionsDir, taskId);
}

function requireSession(paths, taskId) {
  const sessionDir = getSessionDir(paths, taskId);
  if (!fs.existsSync(sessionDir)) {
    throw new Error(`Session does not exist: ${taskId}`);
  }
  return sessionDir;
}

function getSessionFileMap(sessionDir) {
  return {
    brief: path.join(sessionDir, 'brief.md'),
    state: path.join(sessionDir, 'state.md'),
    handoff: path.join(sessionDir, 'handoff.md'),
    decisions: path.join(sessionDir, 'decisions.md'),
    next: path.join(sessionDir, 'next.md'),
    validation: path.join(sessionDir, 'validation.md'),
    log: path.join(sessionDir, 'log.md'),
  };
}

function getProjectPaths(repoPath) {
  const projectHarnessDir = path.join(repoPath, '.harness');
  return {
    repoPath,
    projectHarnessDir,
    projectRulesFile: path.join(projectHarnessDir, 'project-rules.md'),
    agentRolesFile: path.join(projectHarnessDir, 'agent-roles.md'),
    worktreesFile: path.join(projectHarnessDir, 'worktrees.md'),
    integrationQueueFile: path.join(projectHarnessDir, 'integration-queue.md'),
    convexFile: path.join(projectHarnessDir, 'convex.md'),
    handoffsDir: path.join(projectHarnessDir, 'handoffs'),
  };
}

function ensureProjectHarnessDir(paths) {
  ensureDir(paths.projectHarnessDir);
  ensureDir(paths.handoffsDir);
}

function setNamedArg(args, flagName) {
  const idx = args.indexOf(flagName);
  if (idx < 0) return '';
  const value = args[idx + 1];
  if (!value) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return value;
}

function hasFlag(args, flagName) {
  return args.includes(flagName);
}

function getRepoArgOrThrow(args, usageText) {
  const repoValue = setNamedArg(args, '--repo');
  if (!repoValue) {
    throw new Error(usageText);
  }
  return path.resolve(repoValue);
}

function ensureMarkdownFile(filePath, content) {
  ensureFile(filePath, content.endsWith('\n') ? content : `${content}\n`);
}

function headingRegex(level, name) {
  return new RegExp(`(^${escapeRegex(level)} ${escapeRegex(name)}\\n)([\\s\\S]*?)(?=\\n${escapeRegex(level)} |\\n# |$)`, 'm');
}

function setHeadingSection(content, level, name, value) {
  const normalizedValue = `${value}`.trimEnd();
  const regex = headingRegex(level, name);
  if (regex.test(content)) {
    return content.replace(regex, `$1${normalizedValue}\n`);
  }
  const separator = content.endsWith('\n') ? '' : '\n';
  return `${content}${separator}\n${level} ${name}\n${normalizedValue}\n`;
}

function normalizeTaskType(value) {
  return `${value || ''}`.trim().toLowerCase();
}

function isValidTaskType(value) {
  return TASK_TYPES.has(normalizeTaskType(value));
}

function inferTaskTypeFromText(briefContent = '', stateContent = '') {
  const title = getSection(briefContent, 'Title');
  const goal = getSection(briefContent, 'Goal');
  const summary = getSection(stateContent, 'Current Summary');
  const combined = [title, goal, summary].filter(Boolean).join(' ').toLowerCase();

  const trackerSignals = [
    'system-wide session control',
    'session control',
    'meta',
    'tracker',
    'harness',
    'cross-provider',
    'provider compliance',
  ];

  if (trackerSignals.some((signal) => combined.includes(signal))) {
    return 'tracker';
  }

  return DEFAULT_TASK_TYPE;
}

function inferTaskTypeFromTitle(title = '') {
  const normalized = `${title}`.toLowerCase();
  const trackerSignals = [
    'tracker',
    'session control',
    'harness',
    'meta',
    'coordination',
  ];
  if (trackerSignals.some((signal) => normalized.includes(signal))) {
    return 'tracker';
  }
  return DEFAULT_TASK_TYPE;
}

function resolveTaskTypeFromSessionFiles(files) {
  const briefContent = fs.existsSync(files.brief) ? readFile(files.brief) : '';
  const stateContent = fs.existsSync(files.state) ? readFile(files.state) : '';

  const briefTaskType = normalizeTaskType(getSection(briefContent, 'Task Type'));
  if (isValidTaskType(briefTaskType)) return briefTaskType;

  const stateTaskType = normalizeTaskType(getSection(stateContent, 'Task Type'));
  if (isValidTaskType(stateTaskType)) return stateTaskType;

  return inferTaskTypeFromText(briefContent, stateContent);
}

function readSessionTargetRepository(files) {
  const handoff = fs.existsSync(files.handoff) ? readFile(files.handoff) : '';
  const state = fs.existsSync(files.state) ? readFile(files.state) : '';

  const handoffTarget = getSection(handoff, 'Target Repository');
  if (handoffTarget) return handoffTarget;

  const stateTarget = getSection(state, 'Target Repository');
  if (stateTarget) return stateTarget;

  const statePrimary = getSection(state, 'Primary Repository');
  if (statePrimary && statePrimary !== 'unknown') return statePrimary;

  return '';
}

function resolveRouteTargetRepository({ providedRepo, files, gitRoot }) {
  if (providedRepo) return path.resolve(providedRepo);
  const fromSession = readSessionTargetRepository(files);
  if (fromSession) return fromSession;
  if (gitRoot) return gitRoot;
  return path.resolve(process.cwd());
}

function commandStart(gitRoot, rawArgs) {
  const parsed = parseStartArgs(rawArgs);
  const title = parsed.title;
  const taskType = parsed.taskType;
  const typeExplicit = parsed.typeExplicit;
  const targetRepository = parsed.repo || (gitRoot ? path.resolve(gitRoot) : '');
  const primaryRepository = targetRepository || 'unknown';

  const paths = resolveActivePaths(gitRoot);
  ensureHarnessReady(paths);

  const taskId = getNextTaskId(paths.sessionsDir);
  const sessionDir = getSessionDir(paths, taskId);
  ensureDir(sessionDir);

  const templates = createSessionTemplates(taskId, title, {
    taskType,
    primaryRepository,
    targetRepository,
  });
  for (const [name, content] of Object.entries(templates)) {
    writeFile(path.join(sessionDir, name), content);
  }

  let currentSession = readFile(paths.currentSessionFile);
  currentSession = setSection(currentSession, 'Active Task ID', taskId);
  currentSession = setSection(currentSession, 'Current Provider', 'manual');
  currentSession = setSection(currentSession, 'Last Updated', nowStamp());
  writeFile(paths.currentSessionFile, currentSession);

  const logPath = path.join(sessionDir, 'log.md');
  let logContent = readFile(logPath);
  logContent = appendLog(
    logContent,
    `Set as active current session.\n- Task type: ${taskType}${targetRepository ? `\n- Target repository: ${targetRepository}` : ''}`
  );
  writeFile(logPath, logContent);

  console.log(`Started ${taskId}: ${title}`);
  if (typeExplicit) {
    console.log(`Task type: ${taskType}`);
  } else {
    console.log(`Task type: ${taskType} (inferred)`);
  }
  syncHandlesQuietly(paths);
}

function routeTask(gitRoot, args, options = {}) {
  const { silent = false } = options;
  const taskId = args[0];
  const toFlagIndex = args.indexOf('--to');
  const provider = toFlagIndex >= 0 ? args[toFlagIndex + 1] : null;
  const repoFlagIndex = args.indexOf('--repo');
  const repoArg = repoFlagIndex >= 0 ? args[repoFlagIndex + 1] : null;

  if (!taskId || !provider) {
    throw new Error('Usage: atem route <task-id> --to <provider> [--repo <repo-path>]');
  }
  if (toFlagIndex >= 0 && !provider) {
    throw new Error('Usage: atem route <task-id> --to <provider> [--repo <repo-path>]');
  }
  if (repoFlagIndex >= 0 && !repoArg) {
    throw new Error('Usage: atem route <task-id> --to <provider> [--repo <repo-path>]');
  }
  if (!PROVIDERS.has(provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const paths = resolveActivePaths(gitRoot);
  ensureHarnessReady(paths);
  const sessionDir = requireSession(paths, taskId);
  const files = getSessionFileMap(sessionDir);

  const targetRepository = resolveRouteTargetRepository({
    providedRepo: repoArg,
    files,
    gitRoot,
  });

  let state = readFile(files.state);
  const previousProvider = getSection(state, 'Current Provider') || 'None';
  state = setSection(state, 'Current Provider', provider);
  state = setSection(state, 'Target Repository', targetRepository);
  state = setSection(state, 'Last Updated', nowStamp());
  state = syncStateFrontmatter(state, taskId);
  writeFile(files.state, state);

  let handoff = readFile(files.handoff);
  handoff = setSection(handoff, 'Previous Provider', previousProvider);
  handoff = setSection(handoff, 'Next Suggested Provider', provider);
  handoff = setSection(handoff, 'Reason for Suggested Provider', 'Task explicitly routed by user.');
  handoff = setSection(handoff, 'Target Repository', targetRepository);
  writeFile(files.handoff, handoff);

  let currentSession = readFile(paths.currentSessionFile);
  currentSession = setSection(currentSession, 'Active Task ID', taskId);
  currentSession = setSection(currentSession, 'Current Provider', provider);
  currentSession = setSection(currentSession, 'Last Updated', nowStamp());
  writeFile(paths.currentSessionFile, currentSession);

  let logContent = readFile(files.log);
  logContent = appendLog(
    logContent,
    `Routed ${taskId} from ${previousProvider} to ${provider}.\n- Target repository: ${targetRepository}`
  );
  writeFile(files.log, logContent);

  if (!silent) {
    console.log(`Routed ${taskId} to ${provider}`);
    console.log(`Target repository: ${targetRepository}`);
    console.log(`Run \`atem handoff ${taskId}\` to print the provider prompt.`);
  }

  return {
    taskId,
    provider,
    targetRepository,
    previousProvider,
  };
}

function commandRoute(gitRoot, args) {
  routeTask(gitRoot, args, { silent: false });
  syncHandlesQuietly(resolveActivePaths(gitRoot));
}

function commandAdopt(gitRoot, args) {
  const paths = resolveActivePaths(gitRoot);
  ensureHarnessReady(paths);

  // --auto: materialize every detected ambient session in one shot.
  if (args.includes('--auto')) {
    return commandAdoptAuto(gitRoot, paths, args);
  }

  const rawTaskId = args[0];
  if (!rawTaskId) {
    throw new Error('Usage: atem adopt <task-id> [--name <alias>] [--type <task-type>] [--omp-cwd PATH | --omp-file PATH]');
  }

  // --name <alias>: write the alias entry (and materialize, since
  // the user is signaling commitment).
  const nameIdx = args.indexOf('--name');
  const alias = nameIdx >= 0 ? args[nameIdx + 1] : null;
  const typeIdx = args.indexOf('--type');
  const requestedType = typeIdx >= 0 ? args[typeIdx + 1] : null;
  const cwdIdx = args.indexOf('--omp-cwd');
  const fileIdx = args.indexOf('--omp-file');
  const materializeOpts = {
    cwd: cwdIdx >= 0 ? args[cwdIdx + 1] : process.cwd(),
    sessionFile: fileIdx >= 0 ? args[fileIdx + 1] : null,
    taskType: requestedType && isValidTaskType(requestedType) ? requestedType : null,
  };
  const taskId = resolveTaskIdForMutation(paths, rawTaskId, materializeOpts);
  if (alias) {
    require('./aliases.js').setAlias(paths, alias, taskId);
    console.log(`Aliased: ${alias} → ${taskId}`);
  }

  const sessionDir = requireSession(paths, taskId);

  const signals = collectExternalProviderSignals();
  const activeProvidersSection = formatActiveProvidersSection(signals);

  const statePath = path.join(sessionDir, 'state.md');
  const logPath = path.join(sessionDir, 'log.md');
  const handoffPath = path.join(sessionDir, 'handoff.md');

  let state = readFile(statePath);
  const primaryRepository = derivePrimaryRepository(gitRoot, state, signals);
  const relatedWorkspaces = deriveRelatedWorkspaces(primaryRepository, signals);

  state = removeDuplicateSectionBlocks(state, 'Active Providers');
  state = setSection(state, 'Active Providers', activeProvidersSection);
  state = setSection(state, 'Current Summary', 'Adopted current machine-wide provider activity into this task.');
  state = setSection(state, 'Primary Repository', primaryRepository);
  state = setSection(state, 'Related Workspaces', formatRelatedWorkspacesSection(relatedWorkspaces));
  state = setSection(state, 'Last Updated', nowStamp());
  state = state.replace(/\n{3,}/g, '\n\n');
  writeFile(statePath, state);

  let handoff = readFile(handoffPath);
  handoff = setSection(handoff, 'What Was Done', 'Captured active provider sessions and attached them to this task.');
  writeFile(handoffPath, handoff);

  let currentSession = readFile(paths.currentSessionFile);
  currentSession = setSection(currentSession, 'Active Task ID', taskId);
  currentSession = setSection(currentSession, 'Last Updated', nowStamp());
  writeFile(paths.currentSessionFile, currentSession);

  let logContent = readFile(logPath);
  logContent = appendLog(logContent, 'Adopted active provider sessions from machine-wide detection.');
  writeFile(logPath, logContent);

  console.log(`Adopted external provider activity into ${taskId}`);
  syncHandlesQuietly(paths);
}

// `atem adopt --auto` — materialize every detected ambient task that
// isn't already materialized. Skips ones that are.
function commandAdoptAuto(gitRoot, paths, args) {
  const signals = collectExternalProviderSignals();
  const ambient = collectAmbientTasks(signals);
  if (ambient.length === 0) {
    console.log('No ambient sessions detected.');
    return;
  }
  const { materializeSyntheticTask } = require('./materialize.js');
  const created = [];
  const skipped = [];
  for (const row of ambient) {
    const sessionDir = path.join(paths.harnessDir, 'sessions', row.syntheticId);
    if (fs.existsSync(sessionDir)) { skipped.push(row.syntheticId); continue; }
    try {
      materializeSyntheticTask(row.syntheticId, paths, { cwd: row.cwd });
      created.push(row.syntheticId);
    } catch (e) {
      console.error(`Skipped ${row.syntheticId}: ${e.message}`);
    }
  }
  console.log(`Materialized ${created.length} ambient task(s), skipped ${skipped.length} already materialized.`);
  if (created.length > 0) {
    console.log(renderTable(['Materialized'], created.map((id) => [id])));
  }
  syncHandlesQuietly(paths);
}

function firstNumberedItem(content) {
  const match = content.match(/^\d+\.\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function firstNonEmptyLine(value) {
  return `${value || ''}`
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) || '';
}

function isPathInside(candidatePath, basePath) {
  if (!candidatePath || !basePath) return false;
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedBase = path.resolve(basePath);
  return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

function normalizeGoalText(value) {
  return `${value || ''}`.replace(/\s+/g, ' ').trim();
}

function listGoalDocPaths(repoPath, explicitFiles = []) {
  const candidates = explicitFiles.length > 0 ? explicitFiles : GOAL_DOC_CANDIDATES;
  const docs = [];
  for (const file of candidates) {
    const absolutePath = path.isAbsolute(file) ? file : path.join(repoPath, file);
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
      docs.push(path.resolve(absolutePath));
    }
  }
  return uniqueStrings(docs);
}

function extractGoalItemsFromMarkdown(content) {
  const results = [];
  const seen = new Set();
  const lines = `${content || ''}`.split('\n');
  const goalHeading = /\b(goal|goals|roadmap|todo|next|backlog|milestone)\b/i;
  let inGoalSection = false;

  const push = (text) => {
    const normalized = normalizeGoalText(text);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push(normalized);
  };

  for (const line of lines) {
    const headingMatch = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (headingMatch) {
      inGoalSection = goalHeading.test(headingMatch[1]);
      continue;
    }

    const uncheckedMatch = line.match(/^\s*[-*]\s+\[ \]\s+(.+)$/);
    if (uncheckedMatch) {
      push(uncheckedMatch[1]);
      continue;
    }

    const todoInlineMatch = line.match(/\bTODO\b[:\-\s]+(.+)$/i);
    if (todoInlineMatch) {
      push(todoInlineMatch[1]);
      continue;
    }

    if (inGoalSection) {
      const bulletMatch = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
      if (bulletMatch) {
        push(bulletMatch[1]);
      }
    }
  }

  return results;
}

function collectRepoGoals(repoPath, docPaths) {
  const goals = [];
  for (const docPath of docPaths) {
    const content = readFile(docPath);
    const items = extractGoalItemsFromMarkdown(content);
    for (const text of items) {
      goals.push({
        text,
        sourceFile: path.relative(repoPath, docPath) || path.basename(docPath),
      });
    }
  }
  return goals;
}

function collectActiveTasksForRepo(paths, repoPath) {
  if (!fs.existsSync(paths.sessionsDir)) return [];
  const entries = fs.readdirSync(paths.sessionsDir, { withFileTypes: true });
  const tasks = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^TASK-\d+$/.test(entry.name)) continue;

    const sessionDir = path.join(paths.sessionsDir, entry.name);
    const files = getSessionFileMap(sessionDir);
    if (!fs.existsSync(files.state) || !fs.existsSync(files.brief)) continue;

    const state = readFile(files.state);
    const brief = readFile(files.brief);
    const { data: fm } = parseFrontmatter(state);

    const status = normalizeGoalText(fm.status || getSection(state, 'Status') || 'active').toLowerCase();
    if (status === 'complete' || status === 'archived') continue;

    const targetRepo = fm.target_repo
      || getSection(state, 'Target Repository')
      || fm.repo
      || getSection(state, 'Primary Repository');
    const relatedWorkspaces = getSection(state, 'Related Workspaces')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim())
      .filter(Boolean);

    const matchesRepo = isPathInside(targetRepo, repoPath)
      || relatedWorkspaces.some((workspace) => isPathInside(workspace, repoPath));

    if (!matchesRepo) continue;

    const title = getSection(brief, 'Title') || getSection(brief, 'Goal') || entry.name;
    const goal = getSection(brief, 'Goal') || title;
    tasks.push({
      taskId: entry.name,
      title: normalizeGoalText(title),
      goal: normalizeGoalText(goal),
      taskType: normalizeTaskType(getSection(state, 'Task Type') || fm.task_type || ''),
    });
  }

  return tasks;
}

function tokenizeForMatching(value) {
  const stopwords = new Set([
    'the', 'and', 'with', 'from', 'that', 'this', 'into', 'for', 'your', 'are', 'was', 'were',
    'have', 'has', 'will', 'would', 'should', 'could', 'about', 'over', 'under', 'into', 'only',
    'task', 'tasks', 'repo', 'project', 'app', 'apps', 'work', 'done', 'make', 'add',
  ]);
  return new Set(
    `${value || ''}`
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !stopwords.has(token))
  );
}

function bestTaskMatch(goalText, tasks) {
  const goalTokens = tokenizeForMatching(goalText);
  if (goalTokens.size === 0 || tasks.length === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const task of tasks) {
    const taskTokens = tokenizeForMatching(`${task.title} ${task.goal}`);
    let score = 0;
    for (const token of goalTokens) {
      if (taskTokens.has(token)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = task;
    }
  }

  const threshold = goalTokens.size >= 3 ? 2 : 1;
  if (!best || bestScore < threshold) return null;
  return { task: best, score: bestScore };
}

function buildGoalsReportMarkdown(repoPath, docPaths, goals, tasks, unmatchedGoals, unmatchedTasks) {
  const lines = [
    '# ATEM Goal Drift Report',
    '',
    `- Repository: ${repoPath}`,
    `- Generated: ${nowStamp()}`,
    `- Goal docs scanned: ${docPaths.length}`,
    `- Goals found: ${goals.length}`,
    `- Active tasks in repo: ${tasks.length}`,
    `- Untracked goals: ${unmatchedGoals.length}`,
    `- Active tasks without goal match: ${unmatchedTasks.length}`,
    '',
    '## Goal Docs',
  ];

  if (docPaths.length === 0) {
    lines.push('- (none found)');
  } else {
    for (const docPath of docPaths) {
      lines.push(`- ${docPath}`);
    }
  }

  lines.push('', '## Untracked Goals');
  if (unmatchedGoals.length === 0) {
    lines.push('- none');
  } else {
    for (const item of unmatchedGoals) {
      const shortText = item.text.length > 90 ? `${item.text.slice(0, 87)}...` : item.text;
      lines.push(`- [ ] ${item.text}`);
      lines.push(`  - source: ${item.sourceFile}`);
      lines.push(`  - suggested: atem start ${shellQuote(shortText)} --type implementation --repo ${shellQuote(repoPath)}`);
    }
  }

  lines.push('', '## Active Tasks Without Goal Match');
  if (unmatchedTasks.length === 0) {
    lines.push('- none');
  } else {
    for (const task of unmatchedTasks) {
      lines.push(`- ${task.taskId} (${task.taskType || 'unknown'}): ${task.title}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function commandStatus(gitRoot, args = []) {
  const { repoFilter, showAll, explicitRepo, verbose } = parseStatusArgs(args);
  // Phase C.2: auto-scope to the current git repo unless --all or
  // --repo was passed. Explicit --repo always wins.
  let activeScope = repoFilter;
  let autoScoped = false;
  if (!explicitRepo && !showAll && gitRoot) {
    activeScope = gitRoot;
    autoScoped = true;
  }
  console.log(`${PRODUCT_NAME} status`);
  console.log(PRODUCT_TAGLINE);
  if (autoScoped) {
    console.log(`Scoped to ${gitRoot} (auto — pass --all for machine-wide).`);
  } else if (explicitRepo) {
    console.log(`Scoped to ${repoFilter}.`);
  } else {
    console.log('Scope: machine-wide.');
  }
  printExternalProviderActivity(activeScope, { autoScoped, gitRoot, verbose });
  printRepoHarnessStatus(gitRoot, { verbose });
  if (!verbose) {
    console.log('');
    console.log(paint('Tip: pass --verbose for per-PID details and full goal text.', 'gray'));
  }
}

// `atem session` — print the synthetic session id for the current cwd.
// Pipe-friendly default so handoff is one line:
//   atem handoff "$(atem session)" --to codex
// Flags:
//   --all     list every matching id (one per line)
//   --json    structured output with provider, live, title, cwd
//   --repo P  override the cwd
function commandSession(gitRoot, args = []) {
  const usage = 'Usage: atem session [--repo <repo-path>] [--all] [--json] [--verbose]';
  let repoPath = gitRoot || path.resolve(process.cwd());
  let showAll = false;
  let asJson = false;
  let verbose = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--repo') {
      const value = args[i + 1];
      if (!value) throw new Error(usage);
      repoPath = path.resolve(value);
      i += 1;
      continue;
    }
    if (token === '--all') { showAll = true; continue; }
    if (token === '--json') { asJson = true; continue; }
    if (token === '--verbose' || token === '-v') { verbose = true; continue; }
    if (token.startsWith('--') || token.startsWith('-')) {
      throw new Error(`Unknown flag for session: ${token}`);
    }
    throw new Error(usage);
  }

  const signals = collectExternalProviderSignals(repoPath);
  const ambient = collectAmbientTasks(signals);
  const { kept } = dedupeAmbientTasks(ambient);

  if (kept.length === 0) {
    if (asJson) { console.log('[]'); return; }
    console.error(`No active sessions detected for ${repoPath}.`);
    console.error('Hint: open a coding agent in this repo, or pass --repo <other-path>.');
    process.exitCode = 1;
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(kept.map((r) => ({
      id: r.syntheticId,
      provider: r.provider,
      live: r.live,
      title: r.title,
      cwd: r.cwd,
    })), null, 2));
    return;
  }

  if (verbose || showAll) {
    if (verbose) {
      const rows = kept.map((row) => [
        row.syntheticId,
        row.provider,
        row.live ? `${ICONS.ok} live` : `${ICONS.none} ${synthetic.formatRelativeAge(row.mtimeMs) || 'recent'}`,
        ellipsizeRight(row.title, 40) || '—',
      ]);
      console.log(`Sessions for ${repoPath} (${kept.length}):`);
      console.log(renderTable(['ATEM id', 'Provider', 'State', 'Title'], rows));
      console.log('');
      console.log(paint(`Default (live first): ${kept[0].syntheticId}`, 'gray'));
      return;
    }
    for (const row of kept) console.log(row.syntheticId);
    return;
  }

  // Default: one line — the freshest live (or freshest) syntheticId.
  // collectAmbientTasks already sorts live-first then mtime desc.
  console.log(kept[0].syntheticId);
}

function commandWeb(gitRoot, args) {
  const usage = 'Usage: atem web [--port <n>] [--no-open]';
  let port = 4400;
  let open = true;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--port') {
      port = Number(args[++i]);
      if (!Number.isInteger(port) || port < 0) throw new Error(usage);
    } else if (args[i] === '--no-open') {
      open = false;
    } else {
      throw new Error(usage);
    }
  }
  const { createServer } = require('./web/server.js');
  const app = createServer({ cwdRepo: gitRoot });
  app.listen(port, (actualPort) => {
    const url = `http://127.0.0.1:${actualPort}`;
    console.log(`${ICONS.ok} ATEM planning viewer: ${url}`);
    console.log('  Press Ctrl+C to stop.');
    if (open) openInBrowser(url);
  });
}

// Open a URL in the default browser, cross-platform (macOS, Windows, Linux).
function openInBrowser(url, { platform = process.platform, spawnFn = spawn } = {}) {
  let bin;
  let cmdArgs;
  if (platform === 'darwin') { bin = 'open'; cmdArgs = [url]; }
  else if (platform === 'win32') { bin = 'cmd'; cmdArgs = ['/c', 'start', '""', url]; }
  else { bin = 'xdg-open'; cmdArgs = [url]; }
  try {
    spawnFn(bin, cmdArgs, { stdio: 'ignore', detached: true }).unref();
    return true;
  } catch {
    return false; // browser launch is best-effort; the URL is already printed
  }
}

function commandGoals(gitRoot, args = []) {
  const { repoPath, explicitFiles, asJson } = parseGoalsArgs(args, gitRoot);
  const paths = resolveActivePaths(gitRoot);
  ensureHarnessReady(paths);

  const docPaths = listGoalDocPaths(repoPath, explicitFiles);
  const goals = collectRepoGoals(repoPath, docPaths);
  const tasks = collectActiveTasksForRepo(paths, repoPath);

  const matchedTaskIds = new Set();
  const unmatchedGoals = [];
  for (const goal of goals) {
    const match = bestTaskMatch(goal.text, tasks);
    if (!match) {
      unmatchedGoals.push(goal);
      continue;
    }
    matchedTaskIds.add(match.task.taskId);
  }
  const unmatchedTasks = tasks.filter((task) => !matchedTaskIds.has(task.taskId));

  const reportsDir = path.join(paths.harnessDir, 'goals');
  ensureDir(reportsDir);
  const repoSlug = repoPath
    .replace(/^[A-Za-z]:/, '')
    .replace(/[\\/:\s]+/g, '_')
    .replace(/^_+/, '');
  const reportPath = path.join(reportsDir, `${repoSlug || 'repo'}-latest.md`);
  const report = buildGoalsReportMarkdown(
    repoPath,
    docPaths,
    goals,
    tasks,
    unmatchedGoals,
    unmatchedTasks
  );
  writeFile(reportPath, report);

  if (asJson) {
    console.log(JSON.stringify({
      repoPath,
      docCount: docPaths.length,
      goalCount: goals.length,
      activeTaskCount: tasks.length,
      untrackedGoalCount: unmatchedGoals.length,
      unmatchedTaskCount: unmatchedTasks.length,
      reportPath,
      unmatchedGoals,
      unmatchedTasks,
    }, null, 2));
    return;
  }

  console.log(`${PRODUCT_NAME} goals`);
  console.log(`Repo: ${repoPath}`);
  console.log(`Goal docs scanned: ${docPaths.length}`);
  console.log(`Goals found: ${goals.length}`);
  console.log(`Active tasks: ${tasks.length}`);
  console.log(`Untracked goals: ${unmatchedGoals.length}`);
  console.log(`Active tasks without goal match: ${unmatchedTasks.length}`);
  console.log(`Report: ${reportPath}`);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getClaudeSessions() {
  const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
  const sessions = [];
  const files = fs.existsSync(sessionsDir)
    ? fs.readdirSync(sessionsDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(sessionsDir, name))
    : [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFile(file));
      if (!parsed || typeof parsed.pid !== 'number') continue;
      if (!isPidAlive(parsed.pid)) continue;
      const sessionId = parsed.sessionId || '';
      const cwd = parsed.cwd || '';
      const syntheticId = sessionId
        ? synthetic.deriveSyntheticId('claude-code', sessionId)
        : (cwd ? synthetic.cwdFallbackId('claude-code', cwd) : '');
      // Best-effort title from the transcript's first user content.
      // Two paths: (a) walk the first few KB looking for a queue-operation
      // with content (the cheap signal Claude Code itself records), then
      // (b) fall back to a full distill if needed. We bound the scan at
      // 128 KiB to keep `atem status` fast for huge transcripts.
      let title = '';
      if (sessionId) {
        try {
          const cc = require('./adapters/claude-code.js');
          const tFile = cc.findSessionFileById(sessionId);
          if (tFile) {
            const fd = fs.openSync(tFile, 'r');
            const buf = Buffer.alloc(128 * 1024);
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            fs.closeSync(fd);
            const head = buf.slice(0, n).toString('utf8');
            for (const line of head.split('\n')) {
              if (!line.trim()) continue;
              let e; try { e = JSON.parse(line); } catch { continue; }
              // Path (a): queue-operation captures user prompts as top-level content.
              if (e && e.type === 'queue-operation' && e.operation === 'enqueue' && typeof e.content === 'string') {
                title = e.content.replace(/\s+/g, ' ').trim().slice(0, 60);
                break;
              }
              // Path (b): regular message records.
              const msg = e && e.message;
              if (msg && msg.role === 'user') {
                const text = typeof msg.content === 'string'
                  ? msg.content
                  : (Array.isArray(msg.content) && msg.content.find((b) => b && typeof b.text === 'string')?.text) || '';
                if (text) {
                  title = String(text).replace(/\s+/g, ' ').trim().slice(0, 60);
                  break;
                }
              }
            }
          }
        } catch { /* best effort */ }
      }
      sessions.push({
        pid: parsed.pid,
        sessionId: sessionId || 'unknown',
        cwd: cwd || 'unknown',
        entrypoint: parsed.entrypoint || 'unknown',
        startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
        syntheticId,
        title,
      });
    } catch {
      // Ignore malformed files.
    }
  }

  sessions.sort((a, b) => b.startedAt - a.startedAt);

  // Phase C.1: append idle sessions whose transcript was touched
  // within the recent window but whose pid is no longer alive. Live
  // entries win on sessionId collision.
  try {
    const cc = require('./adapters/claude-code.js');
    const liveIds = new Set(sessions.map((s) => s.sessionId).filter((id) => id && id !== 'unknown'));
    const recent = cc.listRecentSessions();
    for (const r of recent) {
      if (!r.sessionId || liveIds.has(r.sessionId)) continue;
      sessions.push({
        pid: null,
        sessionId: r.sessionId,
        cwd: r.cwd || 'unknown',
        entrypoint: 'idle',
        startedAt: r.mtimeMs || 0,
        syntheticId: synthetic.deriveSyntheticId('claude-code', r.sessionId),
        title: r.title || '',
        mtimeMs: r.mtimeMs || 0,
        live: false,
      });
    }
  } catch { /* best effort */ }

  // Stamp live=true on the pid-alive entries for consistent downstream
  // handling. The mtimeMs falls back to startedAt for live sessions so
  // the ambient-task sort still works.
  for (const s of sessions) {
    if (s.live === undefined) s.live = true;
    if (typeof s.mtimeMs !== 'number') s.mtimeMs = s.startedAt || 0;
  }

  return sessions;
}

function getCodexAppServers(processLines = getProcessLines()) {
  return processLines.filter((entry) => entry.command.includes('codex app-server'));
}

function getProcessLines() {
  try {
    const output = execSync('ps -axo pid=,command=', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const firstSpace = line.indexOf(' ');
        if (firstSpace < 0) return null;
        const pid = Number(line.slice(0, firstSpace).trim());
        const command = line.slice(firstSpace + 1);
        if (!Number.isInteger(pid)) return null;
        return { pid, command };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getCodexWorkspaceRoots() {
  const stateFile = path.join(os.homedir(), '.codex', '.codex-global-state.json');
  if (!fs.existsSync(stateFile)) {
    return { active: [], saved: [] };
  }

  try {
    const state = JSON.parse(readFile(stateFile));
    if (!state || typeof state !== 'object') {
      return { active: [], saved: [] };
    }

    const active = Array.isArray(state['active-workspace-roots'])
      ? state['active-workspace-roots'].filter((value) => typeof value === 'string')
      : [];
    const saved = Array.isArray(state['electron-saved-workspace-roots'])
      ? state['electron-saved-workspace-roots'].filter((value) => typeof value === 'string')
      : [];

    return {
      active: uniqueStrings(active),
      saved: uniqueStrings(saved),
    };
  } catch {
    return { active: [], saved: [] };
  }
}

// --- omp (oh-my-pi) detection ---------------------------------------------
// omp stores sessions as JSONL under ~/.omp/agent/sessions/<encoded-cwd>/<id>.jsonl
// First line of each file is a SessionHeader containing the authoritative cwd.
// See docs/research/omp-session-layout.md (T1.1).

function getOmpAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.omp', 'agent');
}

function getOmpSessionsRoot() {
  return path.join(getOmpAgentDir(), 'sessions');
}

function readOmpSessionHeader(filePath) {
  // Header is the first JSONL line; read just enough to parse it.
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const chunk = buf.slice(0, bytesRead).toString('utf8');
    const nl = chunk.indexOf('\n');
    const firstLine = nl === -1 ? chunk : chunk.slice(0, nl);
    if (!firstLine.trim()) return null;
    const parsed = JSON.parse(firstLine);
    if (!parsed || parsed.type !== 'session') return null;
    return parsed;
  } catch {
    return null;
  }
}

function listOmpSessionFiles({ since } = {}) {
  const root = getOmpSessionsRoot();
  if (!fs.existsSync(root)) return [];
  const out = [];
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const subdir = path.join(root, entry.name);
    let files;
    try {
      files = fs.readdirSync(subdir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(subdir, name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (since && stat.mtimeMs < since) continue;
      out.push({ file: full, encodedDir: entry.name, mtimeMs: stat.mtimeMs });
    }
  }
  return out;
}

function getOmpProcesses(processLines = getProcessLines()) {
  // Match the omp binary directly. Guard against false positives like
  // `composer`, `compose`, `comp`, etc. by requiring a word boundary.
  return processLines.filter((entry) => /(^|\/)omp(\s|$)/.test(entry.command));
}

function getOmpProcessCwd(pid) {
  // macOS + Linux: lsof prints the cwd in `n`-prefixed lines.
  try {
    const out = execSync(`lsof -p ${pid} -d cwd -Fn 2>/dev/null`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) {
      if (line.startsWith('n')) return line.slice(1).trim();
    }
  } catch {
    // best-effort
  }
  // Linux fallback.
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return '';
  }
}

function getOmpSessions(processLines = getProcessLines()) {
  // Combine: (a) recently-modified jsonl files under the omp sessions root,
  // (b) live `omp` processes. A session is "live" when an omp pid's cwd
  // matches its header.cwd. Headers are the authoritative source for cwd
  // (the encoded dir name is lossy).
  // Phase C.1: use the shared recent-window for parity with claude-code.
  const candidateFiles = listOmpSessionFiles({ since: Date.now() - synthetic.getRecentWindowMs() });
  if (candidateFiles.length === 0 && getOmpProcesses(processLines).length === 0) {
    return [];
  }

  const procs = getOmpProcesses(processLines).map((p) => ({
    pid: p.pid,
    command: p.command,
    cwd: getOmpProcessCwd(p.pid),
  }));

  const sessions = [];
  for (const cand of candidateFiles) {
    const header = readOmpSessionHeader(cand.file);
    if (!header) continue;
    const cwd = header.cwd || '';
    const matchingProc = procs.find((p) => p.cwd && cwd && path.resolve(p.cwd) === path.resolve(cwd));
    const sessionId = header.id || path.basename(cand.file, '.jsonl');
    sessions.push({
      sessionId,
      cwd,
      title: header.title || '',
      startedAt: header.timestamp ? Date.parse(header.timestamp) : 0,
      mtimeMs: cand.mtimeMs,
      sessionFile: cand.file,
      encodedDir: cand.encodedDir,
      pid: matchingProc ? matchingProc.pid : null,
      live: !!matchingProc,
      syntheticId: sessionId ? synthetic.deriveSyntheticId('omp', sessionId) : (cwd ? synthetic.cwdFallbackId('omp', cwd) : ''),
    });
  }

  // Surface omp processes that have no on-disk session yet (rare, but
  // possible just after launch). Match nothing → still report the process.
  for (const p of procs) {
    if (sessions.some((s) => s.pid === p.pid)) continue;
    sessions.push({
      sessionId: 'unknown',
      cwd: p.cwd || 'unknown',
      title: '',
      startedAt: 0,
      mtimeMs: 0,
      sessionFile: '',
      encodedDir: '',
      pid: p.pid,
      live: true,
      syntheticId: p.cwd ? synthetic.cwdFallbackId('omp', p.cwd) : '',
    });
  }

  sessions.sort((a, b) => (b.live - a.live) || (b.mtimeMs - a.mtimeMs));
  return sessions;
}

function printExternalProviderActivity(repoFilter = '', opts = {}) {
  const signals = collectExternalProviderSignals(repoFilter);
  // Phase C.3: also collect machine-wide signals so we can report
  // "N session(s) in other repos hidden" honestly when scoped.
  const allSignals = (repoFilter || opts.autoScoped) ? collectExternalProviderSignals('') : signals;
  const {
    claudeSessions,
    codexServers,
    codexRoots,
    cursorProcesses,
    opencodeProcesses,
    openrouterProcesses,
    antigravityProcesses,
    ompSessions,
  } = signals;
  const codexDesktopServers = codexServers.filter((entry) => entry.command.includes('/Applications/Codex.app'));
  const codexExtensionServers = codexServers.filter((entry) => !entry.command.includes('/Applications/Codex.app'));
  const totalDetected =
    claudeSessions.length +
    codexServers.length +
    cursorProcesses.length +
    opencodeProcesses.length +
    openrouterProcesses.length +
    (antigravityProcesses ? antigravityProcesses.length : 0) +
    (ompSessions ? ompSessions.length : 0);

  console.log('');
  if (opts.autoScoped) {
    console.log(`Provider activity in ${opts.gitRoot} (${totalDetected} signals):`);
  } else if (repoFilter) {
    console.log(`Provider activity in ${repoFilter} (${totalDetected} signals):`);
  } else {
    console.log(`Provider activity (machine-wide) (${totalDetected} signals):`);
  }

  const fmt = (count, label) => count === 0
    ? `${ICONS.none} ${paint('none detected', 'gray')}`
    : `${ICONS.ok} ${paint(`${count} ${label}`, 'green')}`;
  const summaryRows = [
    [`${ICONS.provider} claude-code`, fmt(claudeSessions.length, 'active session(s)')],
    [`${ICONS.provider} codex`, (codexServers.length === 0 && codexRoots.length === 0)
      ? `${ICONS.none} ${paint('none detected', 'gray')}`
      : fmt(codexServers.length, 'app-server process(es)')],
    [`${ICONS.provider} cursor`, fmt(cursorProcesses.length, 'process(es)')],
    [`${ICONS.provider} opencode`, fmt(opencodeProcesses.length, 'process(es)')],
    [`${ICONS.provider} openrouter`, fmt(openrouterProcesses.length, 'process(es)')],
    [`${ICONS.provider} antigravity`, fmt((antigravityProcesses || []).length, 'process(es)')],
    [`${ICONS.provider} omp`, fmt((ompSessions || []).length, 'session(s)')],
  ];
  console.log(renderTable(['Provider', 'Status'], summaryRows));

  // Details table (only providers with signals)
  const detailRows = [];
  for (const s of claudeSessions.slice(0, 10)) {
    detailRows.push(['claude-code', `pid ${s.pid}`, s.entrypoint, shortenPath(s.cwd, 50)]);
  }
  if (codexDesktopServers.length > 0) detailRows.push(['codex', 'app servers', String(codexDesktopServers.length), '']);
  if (codexExtensionServers.length > 0) detailRows.push(['codex', 'extension servers', String(codexExtensionServers.length), '']);
  for (const root of codexRoots) detailRows.push(['codex', 'workspace root', '', shortenPath(root, 50)]);
  for (const p of cursorProcesses.slice(0, 5)) detailRows.push(['cursor', `pid ${p.pid}`, '', '']);
  for (const p of opencodeProcesses.slice(0, 5)) detailRows.push(['opencode', `pid ${p.pid}`, '', '']);
  for (const p of openrouterProcesses.slice(0, 5)) detailRows.push(['openrouter', `pid ${p.pid}`, '', '']);
  for (const p of (antigravityProcesses || []).slice(0, 5)) detailRows.push(['antigravity', `pid ${p.pid}`, '', '']);
  for (const s of (ompSessions || []).slice(0, 10)) {
    const label = s.live ? (s.pid ? `pid ${s.pid} live` : 'live') : 'recent';
    detailRows.push(['omp', label, ellipsizeRight(s.title || s.sessionId, 40), shortenPath(s.cwd, 50)]);
  }
  if (detailRows.length > 0 && opts.verbose) {
    console.log('');
    console.log(renderTable(['Provider', 'Signal', 'Count', 'Path'], detailRows));
  }

  // Ambient task identity (Phase A + Phase C). Dedupe by (provider, cwd)
  // so a single repo with three abandoned Claude sessions collapses to
  // one row. State column renders `live` or `Nh ago`. Show hidden-
  // elsewhere counts when scope hides some.
  const ambient = collectAmbientTasks(signals);
  const ambientAll = collectAmbientTasks(allSignals);
  const { kept: deduped, elidedCount } = dedupeAmbientTasks(ambient);
  const otherRepoCount = Math.max(0, ambientAll.length - ambient.length);

  if (deduped.length > 0 || otherRepoCount > 0) {
    console.log('');
    console.log(`Detected sessions (${deduped.length}):`);
    const rowLimit = opts.verbose ? 20 : 6;
    const titleWidth = 40;
    const cwdWidth = opts.verbose ? 50 : 32;
    const rows = deduped.slice(0, rowLimit).map((row) => [
      synthetic.shortId(row.syntheticId, 6),
      row.live
        ? `${ICONS.ok} live`
        : `${ICONS.none} ${synthetic.formatRelativeAge(row.mtimeMs) || 'recent'}`,
      ellipsizeRight(row.title, titleWidth) || '—',
      ellipsizeRight(detectWorktreeName(row.cwd), 24) || '—',
      shortenPath(row.cwd, cwdWidth) || '—',
    ]);
    console.log(renderTable(['ATEM id', 'State', 'Title', 'Worktree', 'cwd'], rows));
    const footnotes = [];
    if (deduped.length > rowLimit) footnotes.push(`${deduped.length - rowLimit} more (pass --verbose).`);
    if (elidedCount > 0) footnotes.push(`Same repo, deduped: ${elidedCount} elided.`);
    if (otherRepoCount > 0) footnotes.push(`Other repos: ${otherRepoCount} hidden (pass --all to see).`);
    if (footnotes.length > 0) console.log(footnotes.join(' '));
  }
}

// Phase C.3: keep the freshest entry per (provider, cwd) pair. Live
// beats idle on ties; otherwise mtimeMs desc. Same-repo collisions
// without a cwd ("unknown") are kept individually.
function dedupeAmbientTasks(rows) {
  const sorted = [...rows].sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return (b.mtimeMs || 0) - (a.mtimeMs || 0);
  });
  const seen = new Map();
  const kept = [];
  let elidedCount = 0;
  for (const row of sorted) {
    if (!row.cwd || row.cwd === 'unknown') {
      kept.push(row);
      continue;
    }
    const key = `${row.provider}|${row.cwd}`;
    if (seen.has(key)) { elidedCount += 1; continue; }
    seen.set(key, true);
    kept.push(row);
  }
  return { kept, elidedCount };
}

function collectAmbientTasks(signals) {
  const out = [];
  for (const s of (signals.ompSessions || [])) {
    if (!s.syntheticId) continue;
    out.push({
      syntheticId: s.syntheticId,
      provider: 'omp',
      title: s.title,
      cwd: s.cwd,
      live: !!s.live,
      mtimeMs: s.mtimeMs || 0,
    });
  }
  for (const s of (signals.claudeSessions || [])) {
    if (!s.syntheticId) continue;
    out.push({
      syntheticId: s.syntheticId,
      provider: 'claude-code',
      title: s.title || '',
      cwd: s.cwd,
      // Phase C.1: live or idle. The getClaudeSessions detector
      // stamps both fields.
      live: s.live !== false,
      mtimeMs: s.mtimeMs || s.startedAt || 0,
    });
  }
  // Codex: synthesize cwd-based ids from active workspace roots.
  // Codex doesn't expose a stable session id in its app-server output,
  // so we fall back to a deterministic hash of the cwd.
  for (const root of (signals.codexRoots || [])) {
    if (!root) continue;
    out.push({
      syntheticId: synthetic.cwdFallbackId('codex', root),
      provider: 'codex',
      title: '',
      cwd: root,
      live: true,
      mtimeMs: 0,
    });
  }
  out.sort((a, b) => (b.live - a.live) || (b.mtimeMs - a.mtimeMs));
  return out;
}

// Shorten a path for table display: replace $HOME with `~`, then if
// still over `maxLen`, keep head + tail with a middle ellipsis. The
// tail is preferred ≥ head so the trailing segment (most distinctive
// in a path) stays visible.
function shortenPath(p, maxLen = 50) {
  if (!p || p === 'unknown') return p || '';
  const home = os.homedir();
  let s = p;
  if (home && (s === home || s.startsWith(home + path.sep))) {
    s = '~' + s.slice(home.length);
  }
  if (s.length <= maxLen) return s;
  // Reserve 1 char for `…`. Bias the tail.
  const budget = maxLen - 1;
  const tail = Math.ceil(budget * 0.65);
  const head = budget - tail;
  return s.slice(0, head) + '…' + s.slice(s.length - tail);
}

// Truncate any single-line string to `maxLen` with a trailing ellipsis.
function ellipsizeRight(s, maxLen) {
  if (!s) return '';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length <= maxLen ? flat : flat.slice(0, maxLen - 1) + '…';
}

// Detect whether a cwd is a git worktree checkout. A worktree has `.git`
// as a FILE (containing `gitdir: <main>/.git/worktrees/<name>`) rather
// than a directory. Returns the worktree name when detectable, '' for
// main repo / non-repo / unreadable.
function detectWorktreeName(cwd) {
  if (!cwd || cwd === 'unknown') return '';
  const dotGit = path.join(cwd, '.git');
  let stat;
  try { stat = fs.statSync(dotGit); } catch { return ''; }
  if (stat.isDirectory()) return ''; // main repo
  if (!stat.isFile()) return '';
  let content;
  try { content = fs.readFileSync(dotGit, 'utf8'); } catch { return ''; }
  const m = content.match(/gitdir:\s*(.+)/);
  if (!m) return '';
  const gitdir = m[1].trim();
  // Standard: <main>/.git/worktrees/<name>[/...]
  const wm = gitdir.match(/[/\\]worktrees[/\\]([^/\\]+)/);
  if (wm) return wm[1];
  // Fallback: use the basename of the cwd.
  return path.basename(cwd);
}

function isPathWithinRepo(candidatePath, repoRoot) {
  if (!candidatePath || candidatePath === 'unknown' || !repoRoot) return false;
  // realpath both sides where possible so /tmp ↔ /private/tmp (macOS),
  // /var ↔ /private/var, and symlinked worktrees collapse correctly.
  const real = (p) => {
    try { return fs.realpathSync(p); } catch { return path.resolve(p); }
  };
  const candidate = real(candidatePath);
  const root = real(repoRoot);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function filterSignalsByRepo(signals, repoRoot) {
  if (!repoRoot) return signals;

  const filteredClaude = signals.claudeSessions.filter((session) =>
    isPathWithinRepo(session.cwd, repoRoot)
  );
  const filteredCodexRoots = signals.codexRoots.filter((root) =>
    isPathWithinRepo(root, repoRoot)
  );
  const filteredCodexSavedRoots = signals.codexSavedRoots.filter((root) =>
    isPathWithinRepo(root, repoRoot)
  );

  // Codex app-server processes don't always expose cwd. If we have codex roots
  // under this repo, keep codex app-server signals; otherwise match by command text.
  const filteredCodexServers =
    filteredCodexRoots.length > 0
      ? signals.codexServers
      : signals.codexServers.filter((entry) => entry.command.includes(repoRoot));

  const filteredCursor = signals.cursorProcesses.filter((entry) =>
    entry.command.includes(repoRoot)
  );
  const filteredOpenCode = signals.opencodeProcesses.filter((entry) =>
    entry.command.includes(repoRoot)
  );
  const filteredOpenRouter = signals.openrouterProcesses.filter((entry) =>
    entry.command.includes(repoRoot)
  );
  const filteredAntigravity = (signals.antigravityProcesses || []).filter((entry) =>
    entry.command.includes(repoRoot)
  );

  const filteredOmp = (signals.ompSessions || []).filter((session) =>
    isPathWithinRepo(session.cwd, repoRoot)
  );

  return {
    claudeSessions: filteredClaude,
    codexServers: filteredCodexServers,
    codexRoots: filteredCodexRoots,
    codexSavedRoots: filteredCodexSavedRoots,
    cursorProcesses: filteredCursor,
    opencodeProcesses: filteredOpenCode,
    openrouterProcesses: filteredOpenRouter,
    antigravityProcesses: filteredAntigravity,
    ompSessions: filteredOmp,
  };
}

function collectExternalProviderSignals(repoFilter = '') {
  const processLines = getProcessLines();
  const codexRoots = getCodexWorkspaceRoots();

  // Dedupe key includes sessionId so multiple idle sessions in the
  // same cwd (all carrying pid=null, entrypoint='idle') don't collapse
  // to one signal. Phase C.3 handles same-(provider, cwd) dedupe at
  // the ambient-task level instead, where it belongs.
  const claudeSessions = uniqueBy(getClaudeSessions(), (session) =>
    [session.pid, session.entrypoint, session.cwd, session.sessionId].join('|')
  );
  const codexServers = uniqueBy(getCodexAppServers(processLines), (entry) =>
    [entry.pid, entry.command].join('|')
  );
  const cursorProcesses = uniqueBy(
    processLines.filter((entry) => entry.command.includes('/Cursor.app/Contents/MacOS/Cursor')),
    (entry) => [entry.pid, entry.command].join('|')
  );
  const opencodeProcesses = uniqueBy(
    processLines.filter((entry) =>
      /(^|\/)opencode(\s|$)/i.test(entry.command) || entry.command.includes('/.opencode/')
    ),
    (entry) => [entry.pid, entry.command].join('|')
  );
  const openrouterProcesses = uniqueBy(
    processLines.filter((entry) => /openrouter/i.test(entry.command)),
    (entry) => [entry.pid, entry.command].join('|')
  );
  // Match Antigravity.app processes; exclude unrelated paths (e.g. the
  // pencil MCP helper that lives under ~/.pencil/mcp/antigravity/).
  const antigravityProcesses = uniqueBy(
    processLines.filter((entry) => /\/Antigravity\.app\//i.test(entry.command)),
    (entry) => [entry.pid, entry.command].join('|')
  );
  const ompSessions = uniqueBy(getOmpSessions(processLines), (s) =>
    [s.pid || '', s.sessionFile, s.cwd].join('|')
  );

  const signals = {
    claudeSessions,
    codexServers,
    codexRoots: codexRoots.active,
    codexSavedRoots: codexRoots.saved,
    cursorProcesses,
    opencodeProcesses,
    openrouterProcesses,
    antigravityProcesses,
    ompSessions,
  };

  if (!repoFilter) return signals;
  return filterSignalsByRepo(signals, repoFilter);
}

function formatActiveProvidersSection(signals) {
  const lines = [];

  if (signals.claudeSessions.length > 0) {
    lines.push('### claude-code');
    for (const session of signals.claudeSessions.slice(0, 20)) {
      lines.push(`- pid ${session.pid} | ${session.entrypoint} | ${session.cwd}`);
    }
    lines.push('');
  }

  if (signals.codexServers.length > 0 || signals.codexRoots.length > 0) {
    lines.push('### codex');
    lines.push(`- app-server processes: ${signals.codexServers.length}`);
    if (signals.codexServers.length > 0) {
      const pids = signals.codexServers.slice(0, 30).map((entry) => entry.pid).join(', ');
      lines.push(`- app-server pids: ${pids}`);
    }
    lines.push('- active workspace roots:');
    if (signals.codexRoots.length === 0) {
      lines.push('  - none detected');
    } else {
      for (const root of signals.codexRoots) {
        lines.push(`  - ${root}`);
      }
    }
    lines.push('');
  }

  if (signals.cursorProcesses.length > 0) {
    lines.push('### cursor');
    lines.push(`- process count: ${signals.cursorProcesses.length}`);
    lines.push('');
  }

  if (signals.opencodeProcesses.length > 0) {
    lines.push('### opencode');
    lines.push(`- process count: ${signals.opencodeProcesses.length}`);
    lines.push('');
  }

  if (signals.openrouterProcesses.length > 0) {
    lines.push('### openrouter');
    lines.push(`- process count: ${signals.openrouterProcesses.length}`);
    lines.push('');
  }

  if ((signals.antigravityProcesses || []).length > 0) {
    lines.push('### antigravity');
    lines.push(`- process count: ${signals.antigravityProcesses.length}`);
    lines.push('');
  }

  if (lines.length === 0) {
    return 'None detected.';
  }

  return lines.join('\n').trimEnd();
}

function derivePrimaryRepository(gitRoot, stateContent, signals) {
  if (gitRoot) return gitRoot;

  const existing = getSection(stateContent, 'Primary Repository');
  if (existing && existing !== 'unknown') {
    return existing;
  }

  if (signals.claudeSessions.length > 0) {
    const firstKnown = signals.claudeSessions.find((session) => session.cwd && session.cwd !== 'unknown');
    if (firstKnown) return firstKnown.cwd;
  }

  if (signals.codexRoots.length > 0) {
    return signals.codexRoots[0];
  }

  return 'unknown';
}

function deriveRelatedWorkspaces(primaryRepository, signals) {
  const all = [];
  for (const session of signals.claudeSessions) {
    if (session.cwd && session.cwd !== 'unknown') {
      all.push(session.cwd);
    }
  }
  for (const root of signals.codexRoots) {
    all.push(root);
  }

  const deduped = uniqueStrings(all).filter((item) => item !== primaryRepository);
  return deduped;
}

function formatRelatedWorkspacesSection(workspaces) {
  if (!workspaces || workspaces.length === 0) {
    return 'None detected.';
  }
  return workspaces.map((workspace) => `- ${workspace}`).join('\n');
}

function parseProviderEntries(activeProvidersSection) {
  const lines = activeProvidersSection.split('\n');
  const entries = [];
  let provider = '';

  for (const line of lines) {
    const headingMatch = line.match(/^###\s+(.+)$/);
    if (headingMatch) {
      provider = headingMatch[1].trim();
      continue;
    }

    if (!provider) continue;
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('-')) continue;
    entries.push(`${provider}|${trimmed}`);
  }

  return entries;
}

function requiredSessionFileNames() {
  return [
    'brief.md',
    'state.md',
    'handoff.md',
    'decisions.md',
    'next.md',
    'validation.md',
    'log.md',
  ];
}

function printRepoHarnessStatus(gitRoot, opts = {}) {
  const verbose = !!opts.verbose;
  // Non-verbose: flatten newlines and cap each value at this many chars so
  // the table fits a normal terminal. Verbose: print as-is (multi-line).
  const trunc = (value, max = 80) => {
    if (verbose) return value;
    return ellipsizeRight(value, max);
  };

  console.log('');
  console.log('ATEM context:');

  const paths = resolveActivePaths(gitRoot);
  const repoPaths = gitRoot ? getRepoPaths(gitRoot) : null;

  const ctxRows = [];
  if (gitRoot) {
    ctxRows.push(['git repo', gitRoot]);
  } else {
    ctxRows.push(['git repo', 'no git repository detected from current directory']);
  }
  if (paths.mode === 'global') {
    ctxRows.push(['store mode', 'global handoff store (default)']);
    if (verbose && repoPaths && fs.existsSync(repoPaths.harnessDir)) {
      ctxRows.push(['project store (inactive)', repoPaths.harnessDir]);
      ctxRows.push(['hint', 'set ATEM_HARNESS_MODE=repo to use repo-local harness']);
    }
    if (verbose) ctxRows.push(['state dir', paths.harnessDir]);
  } else {
    ctxRows.push(['store mode', 'project handoff store (ATEM_HARNESS_MODE=repo)']);
    if (verbose) ctxRows.push(['state dir', paths.harnessDir]);
  }

  if (!fs.existsSync(paths.harnessDir)) {
    ctxRows.push(['active task', 'none']);
    console.log(renderTable(['Key', 'Value'], ctxRows));
    console.log('active task: none');
    return;
  }
  ensureHarnessReady(paths);

  const currentSession = readFile(paths.currentSessionFile);
  const taskId = getSection(currentSession, 'Active Task ID') || 'None';

  if (taskId === 'None') {
    ctxRows.push(['active task', 'none']);
    console.log(renderTable(['Key', 'Value'], ctxRows));
    console.log('active task: none');
    return;
  }

  const sessionDir = requireSession(paths, taskId);
  const state = readFile(path.join(sessionDir, 'state.md'));
  const brief = readFile(path.join(sessionDir, 'brief.md'));
  const next = readFile(path.join(sessionDir, 'next.md'));
  const handoff = readFile(path.join(sessionDir, 'handoff.md'));
  const validation = readFile(path.join(sessionDir, 'validation.md'));

  const provider = getSection(state, 'Current Provider') || 'unknown';
  const taskType = normalizeTaskType(getSection(state, 'Task Type')) || 'unknown';
  const goal = getSection(brief, 'Goal') || 'None';
  const status = getSection(state, 'Status') || 'unknown';
  const filesTouched = getSection(state, 'Files Touched') || 'None';
  const nextStep = firstNumberedItem(next) || getSection(handoff, 'Next Recommended Action') || 'None';
  const validationStatus = getSection(validation, 'Results') || 'None';

  ctxRows.push(['active task', taskId]);
  ctxRows.push(['task type', taskType]);
  ctxRows.push(['current provider', provider]);
  ctxRows.push(['goal', trunc(goal, 100)]);
  ctxRows.push(['status', status]);
  ctxRows.push(['next step', trunc(nextStep, 100)]);
  ctxRows.push(['files touched', trunc(filesTouched.replace(/\n+/g, '; '), 100)]);
  ctxRows.push(['validation', trunc(validationStatus.replace(/\n+/g, '; '), 100)]);
  console.log(renderTable(['Key', 'Value'], ctxRows));
}

// F.1: project context auto-discovery. Lives in its own module so
// the buildHandoffPrompt function stays focused on prompt assembly.
const projectContextModule = require('./context.js');

function buildHandoffPrompt(taskId, targetProvider = null, paths = null, targetRepo = null, taskType = DEFAULT_TASK_TYPE) {
  const root = paths ? paths.harnessDir : '.harness';
  const filePath = (relativePath) => {
    if (!paths || paths.mode === 'repo') return `.harness/${relativePath}`;
    return path.join(root, relativePath);
  };
  const repoValue = targetRepo || 'not specified';
  const taskRuleByType = {
    tracker: [
      'This is a tracker task.',
      'Do not modify application code unless a concrete sub-task is explicitly provided.',
      'Your job is to update session state only:',
      '- handoff.md',
      '- state.md',
      '- decisions.md',
      '- next.md',
      '- validation.md',
      '- log.md',
    ],
    implementation: [
      'This is an implementation task.',
      'Make the smallest code change needed to satisfy the task brief.',
      'Keep the change narrow and update the session files before stopping.',
    ],
    investigation: [
      'This is an investigation task.',
      'Inspect, diagnose, and report findings.',
      'Do not modify code unless explicitly instructed.',
    ],
    validation: [
      'This is a validation task.',
      'Run or inspect validation only.',
      'Record commands, results, failures, and recommendations in validation.md and handoff.md.',
    ],
    documentation: [
      'This is a documentation task.',
      'Update documentation only unless explicitly instructed otherwise.',
    ],
    review: [
      'This is a review task.',
      'Review code, diffs, architecture, or session state.',
      'Do not modify code unless explicitly instructed.',
    ],
  };
  const taskRule = taskRuleByType[taskType] || taskRuleByType.implementation;

  return [
    '# ATEM Session Handoff',
    `You are continuing an existing coding task through ${PRODUCT_NAME}.`,
    `${PRODUCT_NAME} is the session handoff layer for AI coding agents.`,
    '',
    '## Task',
    taskId,
    '## Target Provider',
    targetProvider || 'not specified',
    '## Required Read Files',
    'Read these files before doing any work:',
    `1. \`${filePath('current-session.md')}\``,
    `2. \`${filePath('routing.md')}\``,
    `3. \`${filePath('provider-contract.md')}\``,
    `4. \`${filePath(`sessions/${taskId}/brief.md`)}\``,
    `5. \`${filePath(`sessions/${taskId}/state.md`)}\``,
    `6. \`${filePath(`sessions/${taskId}/handoff.md`)}\``,
    `7. \`${filePath(`sessions/${taskId}/decisions.md`)}\``,
    `8. \`${filePath(`sessions/${taskId}/next.md`)}\``,
    `9. \`${filePath(`sessions/${taskId}/validation.md`)}\``,
    '## Repository Boundary',
    `Only work inside the target repository:\n\`${repoValue}\``,
    'Do not modify sibling repositories or sibling worktrees.',
    `Do not modify global ${PRODUCT_NAME} files except the active session files for this task.`,
    '## Task Type Rule',
    ...taskRule,
    '## Work Rule',
    'Continue the task, preserve existing decisions, and make the smallest useful progress.',
    // F.1: include the project's bigger plan when we can find one.
    ...buildProjectContextLines(targetRepo),
    '## Stop Rule',
    'Before stopping, update all relevant session files:',
    '- handoff.md',
    '- state.md',
    '- next.md',
    '- validation.md',
    '- decisions.md where relevant',
    '- log.md',
    'Never end the session without updating `handoff.md`.',
  ].join('\n');
}

// F.1: project context section. Returns the lines to splice into the
// handoff prompt — empty array when nothing was discovered (so we
// don't add noise to projects without these docs).
function buildProjectContextLines(targetRepo) {
  if (!targetRepo) return [];
  try {
    const context = projectContextModule.discoverProjectContext(targetRepo);
    const block = projectContextModule.renderProjectContextSection(context);
    return block ? block.split('\n') : [];
  } catch {
    return [];
  }
}

// AGENTS.md is the rule format omp + codex both honor in the repo root.
// We mark our block so we never clobber human-authored content.
const AGENTS_MD_BEGIN = '<!-- atem:agents:begin -->';
const AGENTS_MD_END = '<!-- atem:agents:end -->';

function buildAgentsMdBlock(taskId, paths, targetRepo, taskType, provider) {
  const sessionRel = path.relative(targetRepo || process.cwd(), path.join(paths.harnessDir, 'sessions', taskId)) || `.harness/sessions/${taskId}`;
  return [
    AGENTS_MD_BEGIN,
    '# ATEM Session Contract',
    '',
    'This repository is participating in an ATEM session-handoff workflow.',
    `Active task: \`${taskId}\` (type: \`${taskType}\`)${provider ? `, current provider: \`${provider}\`` : ''}.`,
    '',
    '## Before doing anything',
    '',
    'Read the active session files. Prefer the stable URL form — same path',
    'regardless of harness mode or future layout changes:',
    '',
    '- `atem://current/brief` — what this task is',
    '- `atem://current/state` — current state',
    '- `atem://current/handoff` — what the previous provider left for you',
    '- `atem://current/next` — what to do next',
    '- `atem://current/decisions` — past decisions you must respect',
    '',
    'Dereference from a shell with `atem resolve <url>`. Same files are',
    'symlinked under `~/.atem/handles/current/*.md` for providers whose',
    'tools only accept literal local paths.',
    '',
    'Concrete paths for this harness (snapshot):',
    `- \`${sessionRel}/brief.md\``,
    `- \`${sessionRel}/state.md\``,
    `- \`${sessionRel}/handoff.md\``,
    `- \`${sessionRel}/next.md\``,
    `- \`${sessionRel}/decisions.md\``,
    '',
    '## Repository boundary',
    '',
    `Only modify files inside \`${targetRepo || '(target repo)'}\`. Never touch sibling repos or sibling worktrees.`,
    '',
    '## Before stopping',
    '',
    'Update the session files (`handoff.md`, `state.md`, `next.md`, `log.md`, and `decisions.md` when relevant).',
    'Never end without updating `handoff.md`.',
    '',
    `Managed by ATEM. Edit content above/below this block, but leave this block intact — \`atem handoff\` regenerates it.`,
    AGENTS_MD_END,
    '',
  ].join('\n');
}

function writeAgentsMd(targetRepo, taskId, paths, taskType, provider) {
  if (!targetRepo) return null;
  if (!fs.existsSync(targetRepo)) return null;
  const dest = path.join(targetRepo, 'AGENTS.md');
  const block = buildAgentsMdBlock(taskId, paths, targetRepo, taskType, provider);
  let next;
  if (fs.existsSync(dest)) {
    const existing = readFile(dest);
    if (existing.includes(AGENTS_MD_BEGIN) && existing.includes(AGENTS_MD_END)) {
      const before = existing.slice(0, existing.indexOf(AGENTS_MD_BEGIN));
      const after = existing.slice(existing.indexOf(AGENTS_MD_END) + AGENTS_MD_END.length).replace(/^\n+/, '');
      next = before + block + after;
    } else {
      next = existing.replace(/\n*$/, '\n\n') + block;
    }
  } else {
    next = block;
  }
  writeFile(dest, next);
  return dest;
}

// Resolve a task id arg through the alias table and (if synthetic and
// unmaterialized) materialize it on demand. Returns the canonical task
// id (alias resolved, synthetic preserved) that downstream code can
// pass to requireSession.
function resolveTaskIdForMutation(paths, rawTaskId, opts = {}) {
  const a = require('./aliases.js');
  const aliasTarget = a.resolveAlias(paths, rawTaskId);
  const taskId = aliasTarget || rawTaskId;
  if (synthetic.isSyntheticId(taskId)) {
    const sessionDir = path.join(paths.harnessDir, 'sessions', taskId);
    if (!fs.existsSync(sessionDir)) {
      const { materializeSyntheticTask } = require('./materialize.js');
      materializeSyntheticTask(taskId, paths, opts);
    }
  }
  return taskId;
}

function commandHandoff(gitRoot, args) {
  const rawTaskId = args[0];
  if (!rawTaskId) {
    throw new Error('Usage: atem handoff <task-id>');
  }
  const toFlagIndex = args.indexOf('--to');
  const provider = toFlagIndex >= 0 ? args[toFlagIndex + 1] : null;
  if (toFlagIndex >= 0 && !provider) {
    throw new Error('Usage: atem handoff <task-id> --to <provider>');
  }
  if (provider && !PROVIDERS.has(provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  const repoFlagIndex = args.indexOf('--repo');
  const targetRepo = repoFlagIndex >= 0 ? args[repoFlagIndex + 1] : null;
  if (repoFlagIndex >= 0 && !targetRepo) {
    throw new Error('Usage: atem handoff <task-id> [--to <provider>] [--repo <repo-path>] [--from <provider> [--omp-cwd PATH|--omp-session ID|--omp-file PATH]]');
  }

  // --from omp: ingest live omp state into ATEM session files before
  // generating the handoff prompt. Other providers may follow.
  const fromIdx = args.indexOf('--from');
  const fromProvider = fromIdx >= 0 ? args[fromIdx + 1] : null;
  if (fromIdx >= 0 && !fromProvider) {
    throw new Error('Usage: atem handoff <task-id> --from <provider>');
  }

  const paths = resolveActivePaths(gitRoot);
  ensureHarnessReady(paths);
  // Phase B: resolve aliases + materialize synthetic ids before any
  // requireSession call. For omp synthetic ids, pass cwd/file flags
  // through so the materializer can find the right jsonl.
  const taskId = resolveTaskIdForMutation(paths, rawTaskId, {
    cwd: targetRepo || process.cwd(),
  });
  const sessionDir = requireSession(paths, taskId);
  const files = getSessionFileMap(sessionDir);

  if (provider) {
    const routeArgs = [taskId, '--to', provider];
    if (targetRepo) {
      routeArgs.push('--repo', targetRepo);
    }
    routeTask(gitRoot, routeArgs, { silent: true });
  }

  let resolvedTargetRepo = targetRepo;
  if (!resolvedTargetRepo) {
    resolvedTargetRepo = readSessionTargetRepository(files);
  }

  if (fromProvider === 'omp') {
    const { adapters: registry } = require('./adapters/index.js');
    const ompCwd = (() => {
      const i = args.indexOf('--omp-cwd');
      return i >= 0 ? args[i + 1] : null;
    })();
    const ompSessionId = (() => {
      const i = args.indexOf('--omp-session');
      return i >= 0 ? args[i + 1] : null;
    })();
    const ompFile = (() => {
      const i = args.indexOf('--omp-file');
      return i >= 0 ? args[i + 1] : null;
    })();
    const cwd = ompCwd || resolvedTargetRepo || process.cwd();
    registry.omp.ingest(taskId, {
      sessionFile: ompFile,
      sessionId: ompSessionId,
      cwd,
    });
  }

  const taskType = resolveTaskTypeFromSessionFiles(files);

  // Drop AGENTS.md at the target repo when handing off TO a provider that
  // honors it (omp + codex + opencode). Idempotent — only replaces our
  // marked block.
  let agentsMdPath = null;
  if (provider && (provider === 'omp' || provider === 'codex' || provider === 'opencode') && resolvedTargetRepo) {
    agentsMdPath = writeAgentsMd(resolvedTargetRepo, taskId, paths, taskType, provider);
    if (agentsMdPath) {
      console.error(`# ATEM: wrote handoff block to ${agentsMdPath}`);
    }
  }

  const handoffPrompt = buildHandoffPrompt(taskId, provider, paths, resolvedTargetRepo, taskType);

  // D.1: dispatch through the launcher table. --print forces fallback
  // to printing the prompt (today's behavior). Without a provider, also
  // print — there's no destination to launch.
  const forcePrint = args.includes('--print');
  if (!provider || forcePrint) {
    console.log(handoffPrompt);
    return;
  }

  const launchers = require('./launchers/index.js');
  const registry = launchers.defaultRegistry();
  const noFocus = args.includes('--no-focus');
  const noRespond = args.includes('--no-respond');
  const input = {
    syntheticId: taskId,
    fromProvider: provider ? (readSessionFrontmatterProvider(files) || 'unknown') : 'unknown',
    toProvider: provider,
    targetRepo: resolvedTargetRepo,
    taskType,
    handoffPrompt,
    paths,
    agentsMdPath,
    fromCli: true,
    focus: !noFocus,
    noRespond,
  };

  (async () => {
    const result = await launchers.dispatch(registry, input, { forcePrint });
    if (result.kind === 'launched') {
      console.log(`✓ ${result.summary}`);
      if (agentsMdPath) {
        console.log(`  AGENTS.md updated in ${path.dirname(agentsMdPath)} — provider will read it on session start.`);
      }
      console.log('  Run `atem handoff <task> --to <provider> --print` to get the raw prompt instead.');
    } else if (result.kind === 'printed') {
      if (result.summary) console.error(`# ATEM: ${result.summary}`);
    }
  })().catch((err) => {
    console.error(`# ATEM handoff failed: ${err.message}`);
    console.log(handoffPrompt);
    process.exitCode = 1;
  });
}

// Small helper used by the launcher dispatch above to surface "who is
// the current provider" from the active state.md.
function readSessionFrontmatterProvider(files) {
  try {
    const state = fs.readFileSync(files.state, 'utf8');
    const fm = parseFrontmatter(state).data;
    return fm.provider || '';
  } catch {
    return '';
  }
}

function commandResolve(gitRoot, args) {
  const url = args[0];
  if (!url) throw new Error('Usage: atem resolve <atem://...> [--raw]');
  const raw = args.includes('--raw');
  const paths = resolveActivePaths(gitRoot);
  const { resolve: resolveUrl } = require('./url.js');
  const result = resolveUrl(url, paths);
  if (result.kind === 'error') {
    throw new Error(`resolve failed [${result.code}]: ${result.message}`);
  }
  if (result.kind === 'file' || result.kind === 'directory') {
    if (raw) {
      console.log(JSON.stringify({ kind: result.kind, localPath: result.localPath, mimeType: result.mimeType }, null, 2));
    } else {
      console.log(result.localPath);
    }
    return;
  }
  if (result.kind === 'virtual') {
    if (raw) {
      console.log(JSON.stringify({ kind: 'virtual', mimeType: result.mimeType, payload: result.payload }, null, 2));
      return;
    }
    if (result.mimeType === 'text/markdown' && typeof result.payload === 'string') {
      console.log(result.payload);
    } else {
      console.log(JSON.stringify(result.payload, null, 2));
    }
    return;
  }
  throw new Error(`resolve returned unexpected kind: ${result.kind}`);
}

function commandUrl(gitRoot, args) {
  const sub = args[0];
  const rest = args.slice(1);
  const handles = handlesModule();
  const paths = resolveActivePaths(gitRoot);
  switch (sub) {
    case 'list': {
      const { resolve: resolveUrl } = require('./url.js');
      const result = resolveUrl('atem://list', paths);
      if (result.kind === 'virtual') {
        console.log(JSON.stringify(result.payload, null, 2));
      } else {
        throw new Error(`atem://list returned unexpected kind: ${result.kind}`);
      }
      return;
    }
    case 'handles': {
      const info = handles.listHandles();
      console.log(JSON.stringify(info, null, 2));
      return;
    }
    case 'sync': {
      const tasks = handles.syncAll(paths);
      console.log(`Synced handle dirs for ${tasks.length} task(s) under ${handles.getHandlesRoot()}`);
      return;
    }
    case 'resolve': {
      return commandResolve(gitRoot, rest);
    }
    default:
      throw new Error('Usage: atem url <list|handles|sync|resolve> [...]');
  }
}

// F.3: install ATEM's MCP server into each provider's config.
/**
 * `atem guardrails <family> <verb>`: the Harness as control plane.
 *
 * Read-only today: inventory, audit, status. `adopt` and `upgrade` write into
 * other repositories and are deliberately absent until they are reviewable on
 * their own.
 *
 * Async because the implementation is ESM and this file is CommonJS. The caller
 * returns the promise so a failure still sets the exit code.
 */
async function commandGuardrails(args) {
  const family = args[0];
  if (!family || family === 'help') {
    console.log('atem guardrails convex <inventory|audit|status>');
    return;
  }
  if (family !== 'convex') {
    throw new Error(`Unknown guardrail family: ${family}. Only "convex" exists.`);
  }
  const mod = await import('../guardrails/convex/fleet-audit/cli.mjs');
  const { code, output } = mod.run(args.slice(1));
  console.log(output);
  if (code !== 0) process.exitCode = code;
}

function commandInstall(args) {
  const installer = require('./installer.js');
  const dryRun = args.includes('--dry-run');
  const perProject = args.includes('--project');
  const withSkill = args.includes('--with-skill');
  const list = args.includes('--list');

  if (list) {
    const rows = installer.listProviders().map((p) => [
      p.name,
      p.label,
      p.detected ? `${ICONS.ok} detected` : `${ICONS.none} not detected`,
      p.paths[0],
    ]);
    console.log(`${PRODUCT_NAME} install — providers`);
    console.log(renderTable(['Provider', 'Label', 'Detection', 'Default config path'], rows));
    return;
  }

  let names;
  const firstPositional = args.find((a) => !a.startsWith('--'));
  if (!firstPositional || firstPositional === 'all') {
    names = installer.detectedProviders();
    if (names.length === 0) {
      console.log('No supported providers detected on this machine.');
      return;
    }
  } else {
    names = [firstPositional];
  }

  console.log(`${PRODUCT_NAME} install${dryRun ? ' (dry run)' : ''}`);
  const rows = [];
  for (const name of names) {
    try {
      const r = installer.installProvider(name, { dryRun, perProject, withSkill });
      rows.push([r.provider, r.label, badgeForStatus(r.status), r.path]);
      if (r.skill) {
        rows.push([`${name}:skill`, 'handoff skill', badgeForStatus(r.skill.status), r.skill.path]);
      }
    } catch (e) {
      rows.push([name, '', `${ICONS.fail} ${e.message}`, '']);
    }
  }
  console.log(renderTable(['Provider', 'Label', 'Status', 'Path'], rows));
  if (!dryRun) {
    console.log('Restart the provider apps to load the new MCP server.');
  }
}

function commandUninstall(args) {
  const installer = require('./installer.js');
  const target = args[0];
  if (!target) throw new Error('Usage: atem uninstall <provider>|all');
  const names = target === 'all' ? installer.detectedProviders() : [target];
  console.log(`${PRODUCT_NAME} uninstall`);
  const rows = [];
  for (const name of names) {
    try {
      const r = installer.uninstallProvider(name);
      rows.push([r.provider, r.label, badgeForStatus(r.status), r.path]);
    } catch (e) {
      rows.push([name, '', `${ICONS.fail} ${e.message}`, '']);
    }
  }
  console.log(renderTable(['Provider', 'Label', 'Status', 'Path'], rows));
}

function badgeForStatus(s) {
  if (s === 'added') return `${ICONS.ok} added`;
  if (s === 'updated') return `${ICONS.ok} updated`;
  if (s === 'unchanged') return `${ICONS.none} unchanged`;
  if (s === 'removed') return `${ICONS.ok} removed`;
  if (s === 'absent') return `${ICONS.none} absent`;
  if (s === 'would-add') return `${ICONS.warn} would add`;
  if (s === 'would-update') return `${ICONS.warn} would update`;
  return s;
}

// W7 — H.3: report provider-state drift across state.md /
// current-session.md / handoff.md / actual detection. Optionally
// unify all of them to a single provider with --unify <name>.
function commandReconcile(gitRoot, args) {
  const taskId = args.find((a) => !a.startsWith('--'));
  if (!taskId) {
    throw new Error('Usage: atem reconcile <task-id> [--unify <provider>] [--json]');
  }
  const unifyIdx = args.indexOf('--unify');
  const unify = unifyIdx >= 0 ? args[unifyIdx + 1] : null;
  if (unifyIdx >= 0 && !unify) {
    throw new Error('Usage: atem reconcile <task-id> --unify <provider>');
  }
  if (unify && !PROVIDERS.has(unify)) {
    throw new Error(`Unknown provider: ${unify}`);
  }
  const asJson = args.includes('--json');

  const paths = resolveActivePaths(gitRoot);
  ensureHarnessReady(paths);
  const sessionDir = requireSession(paths, taskId);
  const files = getSessionFileMap(sessionDir);

  // Pull provider from each surface.
  const state = readFile(files.state);
  const handoff = readFile(files.handoff);
  const currentSession = readFile(paths.currentSessionFile);
  const stateFm = parseFrontmatter(state).data;

  const surfaces = {
    'state.md (Current Provider section)': (getSection(state, 'Current Provider') || '').trim() || null,
    'state.md (frontmatter.provider)':     stateFm.provider || null,
    'handoff.md (Next Suggested Provider)': (getSection(handoff, 'Next Suggested Provider') || '').trim() || null,
    'current-session.md (Current Provider)': (getSection(currentSession, 'Current Provider') || '').trim() || null,
  };

  // Detect actual provider activity for the task's target repo.
  const targetRepo = readSessionTargetRepository(files);
  let detected = [];
  if (targetRepo && targetRepo !== 'unknown') {
    try {
      const signals = collectExternalProviderSignals(targetRepo);
      if ((signals.claudeSessions || []).length > 0) detected.push('claude-code');
      if ((signals.codexServers || []).length > 0 || (signals.codexRoots || []).length > 0) detected.push('codex');
      if ((signals.cursorProcesses || []).length > 0) detected.push('cursor');
      if ((signals.opencodeProcesses || []).length > 0) detected.push('opencode');
      if ((signals.ompSessions || []).length > 0) detected.push('omp');
    } catch { /* best-effort */ }
  }

  const values = Object.values(surfaces).filter(Boolean);
  const unique = [...new Set(values)];
  const drift = unique.length > 1;

  if (asJson) {
    console.log(JSON.stringify({
      taskId,
      surfaces,
      detectedRunning: detected,
      drift,
      uniqueValues: unique,
    }, null, 2));
    return;
  }

  console.log(`${PRODUCT_NAME} reconcile ${taskId}`);
  const rows = Object.entries(surfaces).map(([surface, value]) => [
    surface,
    value || '(empty)',
  ]);
  rows.push(['detected (running on target repo)', detected.join(', ') || '(none)']);
  console.log(renderTable(['Surface', 'Provider'], rows));

  if (!drift) {
    console.log(`${ICONS.ok} no drift — all surfaces agree on "${unique[0] || '(empty)'}".`);
  } else {
    console.log(`${ICONS.warn} drift: ${unique.length} distinct providers across surfaces (${unique.join(', ')}).`);
  }

  if (!unify) {
    if (drift) {
      console.log('');
      console.log('Pass --unify <provider> to set all surfaces to one value.');
    }
    return;
  }

  // Apply unification.
  console.log('');
  console.log(`Unifying surfaces to: ${unify}`);
  const newState = setSection(
    syncStateFrontmatter(state, taskId),
    'Current Provider',
    unify
  );
  // Frontmatter sync uses sections as source-of-truth so set it after section.
  const finalState = (() => {
    const { data, body } = parseFrontmatter(newState);
    data.provider = unify;
    return buildFrontmatter(data) + body;
  })();
  writeFile(files.state, finalState);

  let newHandoff = setSection(handoff, 'Next Suggested Provider', unify);
  writeFile(files.handoff, newHandoff);

  let newCurrent = setSection(currentSession, 'Current Provider', unify);
  newCurrent = setSection(newCurrent, 'Last Updated', nowStamp());
  writeFile(paths.currentSessionFile, newCurrent);

  console.log(`${ICONS.ok} unified state.md, handoff.md, current-session.md → ${unify}.`);
}

// W7 — H.2: roll session files back to a previous snapshot.
function commandRollback(gitRoot, args) {
  const taskId = args.find((a, i) => !a.startsWith('--') && (i === 0 || args[i - 1] !== '--to'));
  if (!taskId) {
    throw new Error('Usage: atem rollback <task-id> [--list] [--to <stamp>] [--dry-run]');
  }
  const list = args.includes('--list');
  const toIdx = args.indexOf('--to');
  const targetStamp = toIdx >= 0 ? args[toIdx + 1] : null;
  if (toIdx >= 0 && !targetStamp) {
    throw new Error('Usage: atem rollback <task-id> --to <stamp>');
  }
  const dryRun = args.includes('--dry-run');

  const paths = resolveActivePaths(gitRoot);
  ensureHarnessReady(paths);
  const sessionDir = requireSession(paths, taskId);
  const snapshotsDir = path.join(sessionDir, 'snapshots');
  if (!fs.existsSync(snapshotsDir)) {
    throw new Error(`No snapshots directory for ${taskId}`);
  }
  const stamps = fs.readdirSync(snapshotsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (stamps.length === 0) {
    throw new Error(`No snapshots saved for ${taskId}`);
  }

  if (list) {
    console.log(`${PRODUCT_NAME} rollback ${taskId} — snapshots`);
    const rows = stamps.map((s) => {
      const dir = path.join(snapshotsDir, s);
      let files;
      try { files = fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort(); } catch { files = []; }
      let stat;
      try { stat = fs.statSync(dir); } catch { stat = null; }
      return [s, files.join(', ') || '(empty)', stat ? new Date(stat.mtimeMs).toISOString() : ''];
    });
    console.log(renderTable(['Stamp', 'Files', 'Created'], rows));
    return;
  }

  const stamp = targetStamp || stamps[stamps.length - 1];
  if (!stamps.includes(stamp)) {
    throw new Error(`Snapshot ${stamp} not found; available: ${stamps.join(', ')}`);
  }
  const snapshotDir = path.join(snapshotsDir, stamp);

  // Build a safety snapshot first so the user can undo a rollback.
  const safetyStamp = `pre-rollback-${nowStamp().replace(/[: ]/g, '-')}`;
  const safetyDir = path.join(snapshotsDir, safetyStamp);
  const restorable = ['state.md', 'handoff.md', 'validation.md', 'brief.md', 'log.md', 'decisions.md', 'next.md'];

  if (dryRun) {
    console.log(`${PRODUCT_NAME} rollback ${taskId} (dry run)`);
    console.log(`Would restore from snapshot: ${stamp}`);
    const rows = [];
    for (const f of restorable) {
      const src = path.join(snapshotDir, f);
      if (fs.existsSync(src)) rows.push([f, '✓ restore', '']);
    }
    console.log(renderTable(['File', 'Action', 'Detail'], rows));
    console.log(`Would create safety snapshot: ${safetyStamp}`);
    return;
  }

  ensureDir(safetyDir);
  for (const f of restorable) {
    const live = path.join(sessionDir, f);
    if (!fs.existsSync(live)) continue;
    writeFile(path.join(safetyDir, f), readFile(live));
  }

  // Restore from chosen snapshot.
  const restored = [];
  for (const f of restorable) {
    const src = path.join(snapshotDir, f);
    if (!fs.existsSync(src)) continue;
    writeFile(path.join(sessionDir, f), readFile(src));
    restored.push(f);
  }
  console.log(`${PRODUCT_NAME} rollback ${taskId}`);
  console.log(`Restored from snapshot: ${stamp}`);
  console.log(`Safety snapshot saved as: ${safetyStamp} (use \`atem rollback ${taskId} --to ${safetyStamp}\` to undo).`);
  console.log(renderTable(['File', 'Action'], restored.map((f) => [f, '✓ restored'])));
}

// W7 — H.1: detect and (optionally) repair recovery issues.
function commandRecover(gitRoot, args) {
  const recovery = require('./recovery.js');
  const paths = resolveActivePaths(gitRoot);
  const fix = args.includes('--fix');
  const yes = args.includes('--yes');
  const asJson = args.includes('--json');
  const taskArg = args.find((a) => !a.startsWith('--'));

  const issues = recovery.detectAllIssues(paths, { taskId: taskArg });

  if (asJson) {
    console.log(JSON.stringify(
      issues.map((i) => ({ code: i.code, severity: i.severity, taskId: i.taskId, message: i.message, remedy: i.remedy.describe })),
      null,
      2
    ));
    return;
  }

  console.log(`${PRODUCT_NAME} recover${taskArg ? ` ${taskArg}` : ' (all sessions)'}`);
  if (issues.length === 0) {
    console.log(`${ICONS.ok} no issues detected.`);
    return;
  }

  const rows = issues.map((i) => [
    levelBadge(i.severity === 'error' ? 'FAIL' : i.severity === 'warning' ? 'WARN' : 'OK'),
    i.code,
    i.taskId,
    i.message,
    i.remedy.describe,
  ]);
  console.log(renderTable(['Level', 'Code', 'Task', 'Issue', 'Remedy'], rows));

  if (!fix) {
    console.log('');
    console.log(`Pass --fix to apply remedies${yes ? '' : ' (interactively — add --yes for non-interactive)'}.`);
    return;
  }

  // --fix mode. With --yes apply all. Without --yes, the user already
  // saw the table and chose --fix; we treat that as explicit consent.
  console.log('');
  console.log(`Applying ${issues.length} remed${issues.length === 1 ? 'y' : 'ies'}…`);
  const results = [];
  for (const issue of issues) {
    try {
      const r = issue.remedy.apply();
      results.push([levelBadge('OK'), issue.code, issue.taskId, r || 'applied']);
    } catch (e) {
      results.push([levelBadge('FAIL'), issue.code, issue.taskId, e.message]);
    }
  }
  console.log(renderTable(['Result', 'Code', 'Task', 'Detail'], results));
}

function commandIngestOmp(gitRoot, args) {
  const taskId = args[0];
  if (!taskId) {
    throw new Error('Usage: atem ingest-omp <task-id> [--cwd PATH | --session-id ID | --file PATH]');
  }
  const paths = resolveActivePaths(gitRoot);
  ensureHarnessReady(paths);
  requireSession(paths, taskId);
  const cwdIdx = args.indexOf('--cwd');
  const idIdx = args.indexOf('--session-id');
  const fileIdx = args.indexOf('--file');
  const { adapters: registry } = require('./adapters/index.js');
  const result = registry.omp.ingest(taskId, {
    cwd: cwdIdx >= 0 ? args[cwdIdx + 1] : null,
    sessionId: idIdx >= 0 ? args[idIdx + 1] : null,
    sessionFile: fileIdx >= 0 ? args[fileIdx + 1] : null,
  });
  console.log(`${PRODUCT_NAME} ingest-omp`);
  console.log(`Task: ${taskId}`);
  console.log(`omp session: ${result.sessionId}`);
  console.log(`Source file: ${result.sessionFile}`);
  console.log(`cwd: ${result.cwd}`);
  if (result.model) console.log(`Model: ${result.model}`);
  if (result.mode && result.mode !== 'none') console.log(`Mode: ${result.mode}`);
  if (result.firstTask) console.log(`First task: ${firstNonEmptyLine(result.firstTask).slice(0, 200)}`);
  if (result.summary) console.log(`Summary: ${firstNonEmptyLine(result.summary).slice(0, 200)}`);
  if (result.pausedMidTool) console.log('Warning: omp session was paused mid tool-call.');
}

function commandClose(gitRoot, args) {
  const taskId = args[0];
  if (!taskId) {
    throw new Error('Usage: atem close <task-id>');
  }

  const paths = resolveActivePaths(gitRoot);
  ensureHarnessReady(paths);
  const sessionDir = requireSession(paths, taskId);

  const statePath = path.join(sessionDir, 'state.md');
  const handoffPath = path.join(sessionDir, 'handoff.md');
  const logPath = path.join(sessionDir, 'log.md');

  let state = readFile(statePath);
  state = setSection(state, 'Status', 'complete');
  state = setSection(state, 'Current Summary', 'Task marked complete.');
  state = setSection(state, 'Last Updated', nowStamp());
  state = syncStateFrontmatter(state, taskId);
  writeFile(statePath, state);

  let handoff = readFile(handoffPath);
  handoff = setSection(handoff, 'Current Status', 'Task is complete.');
  handoff = setSection(handoff, 'Next Recommended Action', 'No further action required.');
  writeFile(handoffPath, handoff);

  let logContent = readFile(logPath);
  logContent = appendLog(logContent, 'Task closed.');
  writeFile(logPath, logContent);

  let currentSession = readFile(paths.currentSessionFile);
  const activeTask = getSection(currentSession, 'Active Task ID');
  if (activeTask === taskId) {
    currentSession = setSection(currentSession, 'Active Task ID', 'None');
    currentSession = setSection(currentSession, 'Current Provider', 'manual');
    currentSession = setSection(currentSession, 'Last Updated', nowStamp());
    writeFile(paths.currentSessionFile, currentSession);
  }

  console.log(`Closed ${taskId}`);
}

function commandDoctor(gitRoot) {
  const paths = resolveActivePaths(gitRoot);

  console.log(`${PRODUCT_NAME} doctor`);
  console.log(PRODUCT_TAGLINE);

  const rows = [];
  const flush = () => {
    if (rows.length > 0) console.log(renderTable(['Level', 'Check'], rows));
  };
  const report = (level, message) => {
    rows.push([levelBadge(level), message]);
  };

  if (!fs.existsSync(paths.harnessDir)) {
    report('FAIL', `harness directory missing: ${paths.harnessDir}`);
    flush();
    return;
  }
  report('OK', `harness directory exists: ${paths.harnessDir}`);

  const rootFiles = [
    ['current-session.md', paths.currentSessionFile],
    ['routing.md', paths.routingFile],
    ['provider-contract.md', paths.providerContractFile],
  ];
  for (const [label, filePath] of rootFiles) {
    if (fs.existsSync(filePath)) {
      report('OK', `${label} present`);
    } else {
      report('FAIL', `${label} missing`);
    }
  }

  if (!fs.existsSync(paths.currentSessionFile)) {
    report('FAIL', 'current session file is missing');
    flush();
    return;
  }

  // Alias table integrity (Phase B). Run BEFORE the per-task checks so
  // broken aliases surface even when there's no active task.
  try {
    const aliasesMod = require('./aliases.js');
    const aliasTable = aliasesMod.readAliases(paths);
    const aliasIds = Object.keys(aliasTable);
    if (aliasIds.length === 0) {
      report('OK', 'no aliases registered');
    } else {
      report('OK', `${aliasIds.length} alias(es) registered`);
      for (const alias of aliasIds) {
        const target = aliasTable[alias];
        const sessionDir = path.join(paths.harnessDir, 'sessions', target);
        if (!fs.existsSync(sessionDir)) {
          if (synthetic.isSyntheticId(target)) {
            report('WARN', `alias "${alias}" → unmaterialized synthetic "${target}" (run \`atem adopt ${target} --name ${alias}\`)`);
          } else {
            report('FAIL', `alias "${alias}" → missing task "${target}"`);
          }
        }
      }
    }
  } catch (e) {
    report('WARN', `alias-table check failed: ${e.message}`);
  }

  const currentSession = readFile(paths.currentSessionFile);
  const taskId = getSection(currentSession, 'Active Task ID') || 'None';
  if (taskId === 'None') {
    report('WARN', 'current session is not set (Active Task ID = None)');
    flush();
    return;
  }
  report('OK', `current session: ${taskId}`);

  const sessionDir = getSessionDir(paths, taskId);
  if (!fs.existsSync(sessionDir)) {
    report('FAIL', `session directory missing: ${sessionDir}`);
    flush();
    return;
  }
  report('OK', `session directory exists: ${sessionDir}`);

  let missingSessionFiles = 0;
  for (const fileName of requiredSessionFileNames()) {
    const filePath = path.join(sessionDir, fileName);
    if (fs.existsSync(filePath)) {
      report('OK', `${fileName} present`);
    } else {
      report('FAIL', `${fileName} missing`);
      missingSessionFiles += 1;
    }
  }
  if (missingSessionFiles > 0) { flush(); return; }

  const brief = readFile(path.join(sessionDir, 'brief.md'));
  const state = readFile(path.join(sessionDir, 'state.md'));
  const briefFm = parseFrontmatter(brief).data;
  const stateFm = parseFrontmatter(state).data;
  const briefTaskType = normalizeTaskType(briefFm.task_type || getSection(brief, 'Task Type'));
  const stateTaskType = normalizeTaskType(stateFm.task_type || getSection(state, 'Task Type'));
  if (briefFm.schema || stateFm.schema) {
    report('OK', `schema: ${stateFm.schema || briefFm.schema}`);
  } else {
    report('WARN', 'no frontmatter schema — run `atem migrate-tasks` to upgrade');
  }
  if (isValidTaskType(briefTaskType) && isValidTaskType(stateTaskType)) {
    report('OK', `task type is valid: ${stateTaskType}`);
    if (briefTaskType !== stateTaskType) {
      report('WARN', `task type mismatch (brief: ${briefTaskType}, state: ${stateTaskType})`);
    }
  } else {
    report(
      'FAIL',
      `task type missing or invalid (brief: ${briefTaskType || 'missing'}, state: ${stateTaskType || 'missing'})`
    );
  }

  const CODE_TOUCHING_TYPES = new Set(['implementation', 'validation', 'investigation', 'review']);
  const primaryRepo = getSection(state, 'Primary Repository');
  const targetRepo = getSection(state, 'Target Repository');
  const repoCandidate = (targetRepo && targetRepo !== 'unknown') ? targetRepo
    : (primaryRepo && primaryRepo !== 'unknown') ? primaryRepo : '';
  if (CODE_TOUCHING_TYPES.has(stateTaskType)) {
    if (!repoCandidate) {
      report('FAIL', `${stateTaskType} task requires a repository (Primary/Target Repository is missing or 'unknown')`);
    } else if (!fs.existsSync(repoCandidate)) {
      report('FAIL', `repository path does not exist: ${repoCandidate}`);
    } else {
      report('OK', `repository present and exists: ${repoCandidate}`);
    }
  } else if (stateTaskType === 'tracker') {
    if (repoCandidate && fs.existsSync(repoCandidate) && fs.existsSync(path.join(repoCandidate, '.git'))) {
      report('WARN', `tracker task points to a real git repo (${repoCandidate}); ensure no code changes are routed here`);
    } else {
      report('OK', 'tracker task has no code-routing repository');
    }
  } else if (stateTaskType === 'documentation') {
    if (repoCandidate && !fs.existsSync(repoCandidate)) {
      report('WARN', `documentation task repository missing: ${repoCandidate}`);
    } else {
      report('OK', `documentation task repository: ${repoCandidate || 'none'}`);
    }
  }

  const extraRepos = stateFm.repos ? stateFm.repos.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (extraRepos.length > 0) {
    const missing = extraRepos.filter((r) => !fs.existsSync(r));
    if (missing.length === 0) {
      report('OK', `multi-repo set (${extraRepos.length}) all exist`);
    } else {
      report('WARN', `multi-repo set has ${missing.length} missing path(s): ${missing.join(', ')}`);
    }
  }

  const activeProvidersSectionCount = sectionCount(state, 'Active Providers');
  if (activeProvidersSectionCount === 1) {
    report('OK', 'single `## Active Providers` section');
  } else if (activeProvidersSectionCount === 0) {
    report('WARN', '`## Active Providers` section missing (run `atem adopt <task-id>` to populate)');
  } else {
    report('FAIL', `expected one \`## Active Providers\` section, found ${activeProvidersSectionCount}`);
  }

  const provider = getSection(state, 'Current Provider');
  if (provider && PROVIDERS.has(provider)) {
    report('OK', `current provider is valid: ${provider}`);
    if (stateTaskType === 'tracker' && provider !== 'manual') {
      report('WARN', `tracker task is routed to ${provider}; ensure this task remains state-only unless explicitly allowed`);
    }
  } else {
    report('FAIL', `invalid current provider: ${provider || 'missing'}`);
  }

  const activeProvidersSection = getSection(state, 'Active Providers');
  const providerEntries = parseProviderEntries(activeProvidersSection);
  const uniqueProviderEntries = new Set(providerEntries);
  if (providerEntries.length === uniqueProviderEntries.size) {
    report('OK', 'no duplicate provider entries');
  } else {
    report('FAIL', `duplicate provider entries found: ${providerEntries.length - uniqueProviderEntries.size}`);
  }

  const signals = collectExternalProviderSignals();
  if (signals.codexServers.length > 1 && signals.codexRoots.length <= 1) {
    report(
      'WARN',
      `codex has ${signals.codexServers.length} processes but ${signals.codexRoots.length} active workspace root(s)`
    );
  } else {
    report('OK', 'codex workspace roots look consistent');
  }

  // omp checks (T1.8)
  const ompSessions = signals.ompSessions || [];
  const ompLive = ompSessions.filter((s) => s.live);
  if (ompSessions.length === 0) {
    report('OK', 'no omp activity detected');
  } else {
    report('OK', `omp: ${ompSessions.length} session(s), ${ompLive.length} live`);
    for (const s of ompSessions) {
      if (s.live && !s.sessionFile) {
        report('WARN', `omp live pid ${s.pid} has no session jsonl yet at cwd ${s.cwd}`);
      }
      if (s.sessionFile && !s.cwd) {
        report('WARN', `omp session ${s.sessionId} has no cwd in header`);
      }
    }
  }

  // Handles farm (~/.atem/handles/): ensure it's in sync + linked correctly.
  try {
    handlesModule().syncAll(paths);
    const v = handlesModule().validate(paths);
    if (v.ok) {
      report('OK', `handle farm clean at ${handlesModule().getHandlesRoot()}`);
    } else {
      for (const issue of v.issues.slice(0, 10)) report('WARN', `handles: ${issue}`);
    }
  } catch (e) {
    report('WARN', `handles farm check failed: ${e.message}`);
  }

  // If current task is routed to omp, the target repo should have AGENTS.md
  // with our managed block — otherwise omp won't see the contract.
  const currentProvider = getSection(currentSession, 'Active Provider') || '';
  const targetRepoLine = getSection(currentSession, 'Target Repository') || '';
  if (currentProvider === 'omp' && targetRepoLine && targetRepoLine !== 'unknown') {
    const agentsPath = path.join(targetRepoLine, 'AGENTS.md');
    if (!fs.existsSync(agentsPath)) {
      report('WARN', `omp routed but ${agentsPath} missing; run \`atem handoff <task> --to omp\` to write it`);
    } else if (!readFile(agentsPath).includes(AGENTS_MD_BEGIN)) {
      report('WARN', `AGENTS.md at ${agentsPath} has no ATEM block; run \`atem handoff <task> --to omp\``);
    } else {
      report('OK', `AGENTS.md present with ATEM block at ${targetRepoLine}`);
    }
  }
  flush();
}

function archiveOneSession(paths, taskId) {
  const sessionDir = path.join(paths.sessionsDir, taskId);
  if (!fs.existsSync(sessionDir)) throw new Error(`Session does not exist: ${taskId}`);
  const archiveDir = path.join(paths.sessionsDir, '_archive');
  ensureDir(archiveDir);
  const dest = path.join(archiveDir, taskId);
  if (fs.existsSync(dest)) throw new Error(`Already archived: ${taskId}`);

  // Stamp status=archived in state.md frontmatter + section before moving.
  const statePath = path.join(sessionDir, 'state.md');
  if (fs.existsSync(statePath)) {
    let state = readFile(statePath);
    const { data, body } = parseFrontmatter(state);
    data.status = 'archived';
    state = buildFrontmatter(data) + body;
    state = setSection(state, 'Status', 'archived');
    state = setSection(state, 'Last Updated', nowStamp());
    writeFile(statePath, state);
  }
  const logPath = path.join(sessionDir, 'log.md');
  if (fs.existsSync(logPath)) {
    writeFile(logPath, appendLog(readFile(logPath), 'Session archived.'));
  }

  fs.renameSync(sessionDir, dest);

  // If this was the active session, clear current-session.md.
  if (fs.existsSync(paths.currentSessionFile)) {
    let cur = readFile(paths.currentSessionFile);
    if (getSection(cur, 'Active Task ID') === taskId) {
      cur = setSection(cur, 'Active Task ID', 'None');
      cur = setSection(cur, 'Current Provider', 'manual');
      cur = setSection(cur, 'Last Updated', nowStamp());
      writeFile(paths.currentSessionFile, cur);
    }
  }
}

function findBrokenSessions(paths) {
  const ids = fs.readdirSync(paths.sessionsDir)
    .filter((n) => /^TASK-\d+$/.test(n))
    .sort();
  const broken = [];
  for (const id of ids) {
    const statePath = path.join(paths.sessionsDir, id, 'state.md');
    if (!fs.existsSync(statePath)) continue;
    const state = readFile(statePath);
    const fm = parseFrontmatter(state).data;
    const primary = fm.repo || getSection(state, 'Primary Repository');
    const target = fm.target_repo || getSection(state, 'Target Repository');
    const repo = (target && target !== 'unknown') ? target
      : (primary && primary !== 'unknown') ? primary : '';
    if (repo && !fs.existsSync(repo)) broken.push({ id, repo });
  }
  return broken;
}

function commandArchive(gitRoot, args) {
  const paths = resolveActivePaths(gitRoot);
  ensureHarnessReady(paths);
  const dryRun = hasFlag(args, '--dry-run');
  const broken = hasFlag(args, '--broken');
  if (broken) {
    const items = findBrokenSessions(paths);
    if (items.length === 0) {
      console.log('No broken-repo sessions found.');
      return;
    }
    console.log(`${PRODUCT_NAME} archive --broken${dryRun ? ' (dry-run)' : ''}`);
    const rows = [];
    for (const { id, repo } of items) {
      if (dryRun) {
        rows.push([`${ICONS.archive} ${paint('would-archive', 'yellow')}`, paint(id, 'bold'), `${ICONS.missing} ${paint(`repo missing: ${repo}`, 'red')}`]);
      } else {
        archiveOneSession(paths, id);
        rows.push([`${ICONS.archive} ${paint('archived', 'green')}`, paint(id, 'bold'), paint(repo, 'gray')]);
      }
    }
    console.log(renderTable(['Action', 'Task', 'Repo'], rows));
    console.log(`Summary: ${items.length} ${dryRun ? 'candidates' : 'archived'}`);
    return;
  }
  const taskId = args.find((a) => /^TASK-\d+$/.test(a));
  if (!taskId) throw new Error('Usage: atem archive <task-id> | atem archive --broken [--dry-run]');
  if (dryRun) {
    console.log(`[would-archive] ${taskId}`);
    return;
  }
  archiveOneSession(paths, taskId);
  console.log(`Archived ${taskId}`);
}

function listSnapshots(sessionDir) {
  const snapsDir = path.join(sessionDir, 'snapshots');
  if (!fs.existsSync(snapsDir)) return [];
  return fs.readdirSync(snapsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function readSnapshotMeta(snapshotDir) {
  const statePath = path.join(snapshotDir, 'state.md');
  const state = fs.existsSync(statePath) ? readFile(statePath) : '';
  const fm = parseFrontmatter(state).data;
  const gitStatusPath = path.join(snapshotDir, 'git-status.txt');
  const gitStatus = fs.existsSync(gitStatusPath) ? readFile(gitStatusPath) : '';
  const diffStatPath = path.join(snapshotDir, 'git-diff-summary.txt');
  const diffStat = fs.existsSync(diffStatPath) ? readFile(diffStatPath) : '';
  return {
    provider: fm.provider || getSection(state, 'Current Provider') || 'unknown',
    status: fm.status || getSection(state, 'Status') || 'unknown',
    taskType: fm.task_type || getSection(state, 'Task Type') || 'unknown',
    summary: getSection(state, 'Current Summary') || '',
    filesTouched: getSection(state, 'Files Touched') || '',
    gitStatus: gitStatus.trim(),
    diffStat: diffStat.trim(),
  };
}

function parseGitStatusFiles(gitStatus) {
  return gitStatus.split('\n')
    .filter((l) => l && !l.startsWith('##'))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

function commandSnapshotDiff(gitRoot, args) {
  const taskId = args.find((a) => /^TASK-\d+$/.test(a));
  if (!taskId) throw new Error('Usage: atem snapshot-diff <task-id> [<snap-a> <snap-b>]');
  const paths = resolveActivePaths(gitRoot);
  const sessionDir = requireSession(paths, taskId);
  const all = listSnapshots(sessionDir);
  if (all.length < 2) {
    console.log(`Need at least 2 snapshots for ${taskId} (have ${all.length}).`);
    return;
  }
  const stamps = args.filter((a) => !/^TASK-\d+$/.test(a) && !a.startsWith('--'));
  const a = stamps[0] || all[all.length - 2];
  const b = stamps[1] || all[all.length - 1];
  const aDir = path.join(sessionDir, 'snapshots', a);
  const bDir = path.join(sessionDir, 'snapshots', b);
  if (!fs.existsSync(aDir)) throw new Error(`Snapshot not found: ${a}`);
  if (!fs.existsSync(bDir)) throw new Error(`Snapshot not found: ${b}`);

  const am = readSnapshotMeta(aDir);
  const bm = readSnapshotMeta(bDir);

  const aFiles = new Set(parseGitStatusFiles(am.gitStatus));
  const bFiles = new Set(parseGitStatusFiles(bm.gitStatus));
  const newFiles = [...bFiles].filter((f) => !aFiles.has(f));
  const droppedFiles = [...aFiles].filter((f) => !bFiles.has(f));

  const lines = [];
  lines.push(`# Snapshot Diff: ${taskId}`);
  lines.push(`From: ${a}`);
  lines.push(`To:   ${b}`);
  lines.push('');
  lines.push('## Provider Transition');
  lines.push(am.provider === bm.provider ? `(unchanged) ${am.provider}` : `${am.provider} → ${bm.provider}`);
  lines.push('');
  lines.push('## Status Transition');
  lines.push(am.status === bm.status ? `(unchanged) ${am.status}` : `${am.status} → ${bm.status}`);
  lines.push('');
  lines.push('## Working-Tree Files (git status)');
  lines.push(`- Files in A: ${aFiles.size}`);
  lines.push(`- Files in B: ${bFiles.size}`);
  if (newFiles.length) lines.push(`- New in B:\n${newFiles.map((f) => `  - ${f}`).join('\n')}`);
  if (droppedFiles.length) lines.push(`- Dropped in B:\n${droppedFiles.map((f) => `  - ${f}`).join('\n')}`);
  lines.push('');
  lines.push('## Diff Stat (B)');
  lines.push(bm.diffStat || '(empty)');
  lines.push('');
  if (am.summary || bm.summary) {
    lines.push('## Current Summary');
    lines.push(`A: ${am.summary || '(none)'}`);
    lines.push(`B: ${bm.summary || '(none)'}`);
  }
  console.log(lines.join('\n'));
}

function commandRepos(args) {
  const usage = 'Usage: atem repos <task-id> <list|add> [path]';
  const [taskId, verb, repoPath] = args;
  if (!taskId || !verb) throw new Error(usage);
  const session = require('./adapters/session.js');
  if (verb === 'list') {
    const repos = session.listRepos(taskId);
    if (repos.length === 0) {
      console.log('(no repos)');
    } else {
      const rows = repos.map((r) => [
        fs.existsSync(r) ? `${ICONS.ok} ${paint('ok', 'green')}` : `${ICONS.missing} ${paint('MISSING', 'red')}`,
        `${ICONS.repo} ${r}`,
      ]);
      console.log(renderTable(['Status', 'Repository'], rows));
    }
    return;
  }
  if (verb === 'add') {
    if (!repoPath) throw new Error('Usage: atem repos <task-id> add <path>');
    const repos = session.addRepo(taskId, repoPath);
    console.log(`Repos for ${taskId}:`);
    const rows = repos.map((r) => [fs.existsSync(r) ? 'ok' : 'MISSING', r]);
    console.log(renderTable(['Status', 'Repository'], rows));
    return;
  }
  throw new Error(usage);
}

function commandAdapter(args) {
  const usage = 'Usage: atem adapter <provider> <read|update|log|decision|validation|touched> <task-id> [...]';
  const [provider, verb, taskId, ...rest] = args;
  if (!provider || !verb || !taskId) throw new Error(usage);
  // Lazy require to avoid circular load while cli.js is still initializing.
  const registry = require('./adapters');
  const adapter = registry.get(provider);
  switch (verb) {
    case 'read': {
      console.log(JSON.stringify(adapter.read(taskId), null, 2));
      return;
    }
    case 'update': {
      // rest as key=value pairs
      const patch = {};
      for (const kv of rest) {
        const idx = kv.indexOf('=');
        if (idx === -1) throw new Error(`Bad patch entry: ${kv} (expected key=value)`);
        patch[kv.slice(0, idx)] = kv.slice(idx + 1);
      }
      console.log(JSON.stringify(adapter.update(taskId, patch), null, 2));
      return;
    }
    case 'log': {
      adapter.log(taskId, rest.join(' '));
      console.log('logged');
      return;
    }
    case 'decision': {
      const payload = { decision: rest.join(' ') };
      adapter.decision(taskId, payload);
      console.log('decision recorded');
      return;
    }
    case 'validation': {
      adapter.validation(taskId, { command: rest.join(' '), result: 'pending' });
      console.log('validation recorded');
      return;
    }
    case 'touched': {
      adapter.touched(taskId, rest);
      console.log('files touched recorded');
      return;
    }
    default:
      throw new Error(usage);
  }
}

function commandMigrateTasks(gitRoot, args) {
  const dryRun = hasFlag(args, '--dry-run');
  const paths = resolveActivePaths(gitRoot);
  ensureHarnessReady(paths);
  const sessionsDir = paths.sessionsDir;
  if (!fs.existsSync(sessionsDir)) {
    console.log('No sessions directory found.');
    return;
  }
  const taskIds = fs.readdirSync(sessionsDir)
    .filter((name) => /^TASK-\d+$/.test(name))
    .sort();

  console.log(`${PRODUCT_NAME} migrate-tasks${dryRun ? ' (dry-run)' : ''}`);
  console.log(`Scanning ${taskIds.length} session(s) in ${sessionsDir}`);
  console.log('');

  let changed = 0;
  let brokenRepos = 0;
  let okCount = 0;
  const rows = [];

  for (const taskId of taskIds) {
    const sessionDir = path.join(sessionsDir, taskId);
    const files = getSessionFileMap(sessionDir);
    if (!fs.existsSync(files.brief) || !fs.existsSync(files.state)) {
      rows.push([`${ICONS.skip} ${paint('[SKIP]', 'gray')}`, paint(taskId, 'bold'), '', paint('missing brief.md or state.md', 'gray')]);
      continue;
    }
    let brief = readFile(files.brief);
    let state = readFile(files.state);

    const title = getSection(brief, 'Title') || getSection(brief, 'Goal') || '';
    const briefType = normalizeTaskType(getSection(brief, 'Task Type'));
    const stateType = normalizeTaskType(getSection(state, 'Task Type'));

    let resolvedType = '';
    if (isValidTaskType(stateType)) resolvedType = stateType;
    else if (isValidTaskType(briefType)) resolvedType = briefType;
    else resolvedType = inferTaskTypeFromTitle(title) || DEFAULT_TASK_TYPE;

    const briefNeedsType = !isValidTaskType(briefType);
    const stateNeedsType = !isValidTaskType(stateType);
    const typeMismatch = isValidTaskType(briefType) && isValidTaskType(stateType) && briefType !== stateType;

    const notes = [];

    if (briefNeedsType) {
      brief = setHeadingSection(brief, 2, 'Task Type', resolvedType);
      notes.push(`brief Task Type → ${resolvedType}`);
    }
    if (stateNeedsType) {
      state = setSection(state, 'Task Type', resolvedType);
      notes.push(`state Task Type → ${resolvedType}`);
    }
    if (typeMismatch) {
      state = setSection(state, 'Task Type', resolvedType);
      notes.push(`state Task Type aligned to brief (${resolvedType})`);
    }

    const briefHasFm = parseFrontmatter(brief).data.schema;
    const stateHasFm = parseFrontmatter(state).data.schema;
    if (!briefHasFm) {
      brief = buildFrontmatter({ task_id: taskId, task_type: resolvedType, schema: 'atem.session.v1' }) + brief;
      notes.push('added brief frontmatter');
    }
    if (!stateHasFm) {
      const status = getSection(state, 'Status') || 'active';
      const provider = getSection(state, 'Current Provider') || 'manual';
      const primary = getSection(state, 'Primary Repository') || '';
      const target = getSection(state, 'Target Repository') || '';
      state = buildFrontmatter({
        task_id: taskId,
        task_type: resolvedType,
        status,
        provider,
        repo: primary,
        target_repo: target,
        schema: 'atem.session.v1',
      }) + state;
      notes.push('added state frontmatter');
    }

    const primary = getSection(state, 'Primary Repository');
    const target = getSection(state, 'Target Repository');
    const repoCandidate = (target && target !== 'unknown') ? target
      : (primary && primary !== 'unknown') ? primary : '';
    let repoNote = '';
    if (repoCandidate && !fs.existsSync(repoCandidate)) {
      brokenRepos += 1;
      repoNote = `broken repo: ${repoCandidate}`;
    } else if (!repoCandidate && ['implementation', 'validation', 'investigation', 'review'].includes(resolvedType)) {
      repoNote = `missing repo for ${resolvedType} task`;
    }

    if (notes.length > 0) {
      if (!dryRun) {
        state = setSection(state, 'Last Updated', nowStamp());
        writeFile(files.brief, brief);
        writeFile(files.state, state);
      }
      changed += 1;
      rows.push([
        `${ICONS.fix} ${paint('[FIX]', 'cyan')}`,
        paint(taskId, 'bold'),
        paint(resolvedType, 'magenta'),
        `${notes.join('; ')}${repoNote ? `  ${ICONS.warn} ${paint(repoNote, 'yellow')}` : ''}`,
      ]);
    } else if (repoNote) {
      rows.push([
        `${ICONS.warn} ${paint('[WARN]', 'yellow')}`,
        paint(taskId, 'bold'),
        paint(resolvedType, 'magenta'),
        paint(repoNote, 'yellow'),
      ]);
    } else {
      okCount += 1;
    }
  }

  if (rows.length > 0) console.log(renderTable(['Level', 'Task', 'Type', 'Notes'], rows));
  console.log('');
  console.log(`Summary: ${changed} changed, ${brokenRepos} broken repos, ${okCount} ok${dryRun ? ' (dry-run — no writes)' : ''}`);
}

function commandClean(gitRoot, args) {
  const taskId = args[0];
  if (!taskId) {
    throw new Error('Usage: atem clean <task-id>');
  }

  const paths = resolveActivePaths(gitRoot);
  ensureHarnessReady(paths);
  const sessionDir = requireSession(paths, taskId);
  const files = getSessionFileMap(sessionDir);
  const briefPath = files.brief;
  const statePath = path.join(sessionDir, 'state.md');
  const logPath = path.join(sessionDir, 'log.md');

  let brief = readFile(briefPath);
  let state = readFile(statePath);
  const signals = collectExternalProviderSignals();
  const primaryRepository = derivePrimaryRepository(gitRoot, state, signals);
  const relatedWorkspaces = deriveRelatedWorkspaces(primaryRepository, signals);
  const resolvedTaskType = resolveTaskTypeFromSessionFiles(files);

  if (!getSection(state, 'Status')) {
    state = setSection(state, 'Status', 'active');
  }

  const currentProvider = getSection(state, 'Current Provider');
  if (!currentProvider || !PROVIDERS.has(currentProvider)) {
    state = setSection(state, 'Current Provider', 'manual');
  }

  if (!getSection(state, 'Current Summary')) {
    state = setSection(state, 'Current Summary', 'Session normalized by atem clean.');
  }
  if (!getSection(state, 'Files Touched')) {
    state = setSection(state, 'Files Touched', 'None yet.');
  }
  if (!getSection(state, 'Known Issues')) {
    state = setSection(state, 'Known Issues', 'None yet.');
  }
  state = setSection(state, 'Task Type', resolvedTaskType);
  brief = setSection(brief, 'Task Type', resolvedTaskType);

  state = removeDuplicateSectionBlocks(state, 'Active Providers');
  state = setSection(state, 'Primary Repository', primaryRepository);
  state = setSection(state, 'Related Workspaces', formatRelatedWorkspacesSection(relatedWorkspaces));
  state = setSection(state, 'Active Providers', formatActiveProvidersSection(signals));
  state = setSection(state, 'Last Updated', nowStamp());
  state = state.replace(/\n{3,}/g, '\n\n');
  brief = brief.replace(/\n{3,}/g, '\n\n');
  if (!state.endsWith('\n')) state = `${state}\n`;
  if (!brief.endsWith('\n')) brief = `${brief}\n`;
  writeFile(briefPath, brief);
  writeFile(statePath, state);

  if (fs.existsSync(logPath)) {
    let logContent = readFile(logPath);
    logContent = appendLog(logContent, 'Normalized state.md with deduplicated provider context.');
    writeFile(logPath, logContent);
  }

  console.log(`Cleaned ${taskId}`);
}

function resolveSnapshotRepository({ providedRepo, files, gitRoot }) {
  if (providedRepo) return path.resolve(providedRepo);
  const fromHandoff = fs.existsSync(files.handoff) ? getSection(readFile(files.handoff), 'Target Repository') : '';
  if (fromHandoff) return fromHandoff;
  const fromStatePrimary = fs.existsSync(files.state) ? getSection(readFile(files.state), 'Primary Repository') : '';
  if (fromStatePrimary && fromStatePrimary !== 'unknown') return fromStatePrimary;
  if (gitRoot) return gitRoot;
  return path.resolve(process.cwd());
}

function getGitRepoRoot(repoPath) {
  try {
    const output = execFileSync('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim();
  } catch {
    return '';
  }
}

function runGitCommand(repoRoot, args) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stdout = error && typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = error && typeof error.stderr === 'string' ? error.stderr : '';
    return `${stdout}${stderr}`.trimEnd();
  }
}

function gitCommandSucceeds(repoRoot, args) {
  try {
    execFileSync('git', ['-C', repoRoot, ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function createUniqueSnapshotDir(sessionDir, stamp) {
  const snapshotsRoot = path.join(sessionDir, 'snapshots');
  ensureDir(snapshotsRoot);

  const baseDir = path.join(snapshotsRoot, stamp);
  if (!fs.existsSync(baseDir)) {
    ensureDir(baseDir);
    return baseDir;
  }

  let counter = 1;
  while (counter < 1000) {
    const suffix = String(counter).padStart(2, '0');
    const candidate = path.join(snapshotsRoot, `${stamp}-${suffix}`);
    if (!fs.existsSync(candidate)) {
      ensureDir(candidate);
      return candidate;
    }
    counter += 1;
  }

  throw new Error('Unable to create unique snapshot directory');
}

function commandSnapshot(gitRoot, args) {
  const taskId = args[0];
  if (!taskId) {
    throw new Error('Usage: atem snapshot <task-id> [--repo <repo-path>]');
  }

  const repoFlagIndex = args.indexOf('--repo');
  const repoArg = repoFlagIndex >= 0 ? args[repoFlagIndex + 1] : null;
  if (repoFlagIndex >= 0 && !repoArg) {
    throw new Error('Usage: atem snapshot <task-id> [--repo <repo-path>]');
  }

  const paths = resolveActivePaths(gitRoot);
  ensureHarnessReady(paths);
  const sessionDir = requireSession(paths, taskId);
  const files = getSessionFileMap(sessionDir);

  const repoPath = resolveSnapshotRepository({
    providedRepo: repoArg,
    files,
    gitRoot,
  });
  const repoRoot = getGitRepoRoot(repoPath);
  if (!repoRoot) {
    throw new Error(`Error: target repository is not a git repository: ${repoPath}`);
  }

  const stamp = snapshotStamp();
  const snapshotDir = createUniqueSnapshotDir(sessionDir, stamp);

  const gitStatus = runGitCommand(repoRoot, ['status', '--short', '--branch']);
  const gitDiffSummary = runGitCommand(repoRoot, ['diff', '--stat']);
  const gitDiffPatch = runGitCommand(repoRoot, ['diff']);
  const gitBranch = runGitCommand(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();

  writeFile(path.join(snapshotDir, 'git-status.txt'), `${gitStatus}${gitStatus.endsWith('\n') ? '' : '\n'}`);
  writeFile(path.join(snapshotDir, 'git-diff-summary.txt'), `${gitDiffSummary}${gitDiffSummary.endsWith('\n') ? '' : '\n'}`);
  writeFile(path.join(snapshotDir, 'git-diff.patch'), `${gitDiffPatch}${gitDiffPatch.endsWith('\n') ? '' : '\n'}`);

  writeFile(path.join(snapshotDir, 'state.md'), readFile(files.state));
  writeFile(path.join(snapshotDir, 'handoff.md'), readFile(files.handoff));
  writeFile(path.join(snapshotDir, 'validation.md'), readFile(files.validation));

  const snapshotSummary = [
    '# Snapshot',
    '## Task',
    taskId,
    '## Timestamp',
    nowStamp(),
    '## Repository',
    repoRoot,
    '## Git Branch',
    gitBranch || 'unknown',
    '## Git Status',
    'See `git-status.txt`.',
    '## Diff Summary',
    'See `git-diff-summary.txt`.',
    '## Full Diff',
    'See `git-diff.patch`.',
    '## Session Files',
    '- state.md',
    '- handoff.md',
    '- validation.md',
    '',
  ].join('\n');
  writeFile(path.join(snapshotDir, 'snapshot.md'), snapshotSummary);

  let logContent = readFile(files.log);
  logContent = appendLog(logContent, `Created snapshot at ${snapshotDir}\n- Repository: ${repoRoot}`);
  writeFile(files.log, logContent);

  if (!gitDiffPatch.trim()) {
    console.log(`Snapshot created: ${snapshotDir}`);
    console.log('No working tree diff detected.');
    return;
  }

  console.log(`Snapshot created: ${snapshotDir}`);
}

function commandInstructions(gitRoot, args) {
  const provider = args[0];
  if (!provider) {
    throw new Error('Usage: atem instructions <provider>');
  }
  if (!PROVIDERS.has(provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const paths = resolveActivePaths(gitRoot);
  ensureHarnessReady(paths);

  const currentSession = readFile(paths.currentSessionFile);
  const taskId = getSection(currentSession, 'Active Task ID') || '<active-task-id>';
  const currentTaskIsSet = taskId !== 'None' && taskId !== '<active-task-id>';
  const sessionDir = currentTaskIsSet ? getSessionDir(paths, taskId) : path.join(paths.sessionsDir, '<active-task-id>');
  const files = getSessionFileMap(sessionDir);

  let targetRepo = 'not specified';
  if (currentTaskIsSet) {
    const resolved = readSessionTargetRepository(files);
    if (resolved) targetRepo = resolved;
  }

  const installTargets = {
    'claude-code': 'CLAUDE.md',
    codex: '.codex/instructions.md',
    cursor: '.cursorrules',
    opencode: 'AGENTS.md',
    openrouter: 'AGENTS.md',
    omp: 'AGENTS.md',
    'local-model': 'AGENTS.md',
    manual: 'AGENTS.md',
  };

  const lines = [
    '# ATEM Provider Contract',
    `${PRODUCT_NAME} is the session handoff layer for this coding workflow.`,
    'Before doing any work, read the active ATEM session files.',
    'Before stopping, update the active ATEM session files.',
    '',
    `Provider: ${provider}`,
    `Suggested install target: ${installTargets[provider]}`,
    '',
    '## Required Read Files',
    'Prefer the stable `atem://` URL form — same path regardless of',
    'harness mode (global vs repo) or future layout changes.',
    'Use `atem resolve <url>` from a shell to dereference to a real path.',
    '',
    '- `atem://current/brief`     (the task)',
    '- `atem://current/state`     (where things stand)',
    '- `atem://current/handoff`   (what the previous provider left for you)',
    '- `atem://current/decisions` (don\'t re-litigate these)',
    '- `atem://current/next`      (what to do next)',
    '- `atem://current/validation` (test/audit notes)',
    '',
    'Materialized as files under `~/.atem/handles/current/*.md` for',
    'providers whose tools only accept literal local paths.',
    '',
    'Concrete paths for this harness (snapshot — may move):',
    `  1. \`${paths.currentSessionFile}\``,
    `  2. \`${paths.routingFile}\``,
    `  3. \`${paths.providerContractFile}\``,
    `  4. \`${files.brief}\``,
    `  5. \`${files.state}\``,
    `  6. \`${files.handoff}\``,
    `  7. \`${files.decisions}\``,
    `  8. \`${files.next}\``,
    `  9. \`${files.validation}\``,
    '## Repository Boundary',
    `Only work inside the target repository unless explicitly instructed otherwise.\nTarget repository: ${targetRepo}`,
    'Do not modify sibling repositories, sibling worktrees, or global ATEM files except the active session files.',
    '## Before Stopping',
    'Update:',
    '- handoff.md',
    '- state.md',
    '- next.md',
    '- validation.md',
    '- decisions.md where relevant',
    '- log.md',
    'Never end a session without updating handoff.md.',
  ];

  console.log(lines.join('\n'));
}

function commandOpen(gitRoot, args) {
  const taskId = args[0];
  if (!taskId) {
    throw new Error('Usage: atem open <task-id> [--file <name>]');
  }

  const fileFlagIndex = args.indexOf('--file');
  const requestedFileRaw = fileFlagIndex >= 0 ? args[fileFlagIndex + 1] : null;
  if (fileFlagIndex >= 0 && !requestedFileRaw) {
    throw new Error('Usage: atem open <task-id> [--file <name>]');
  }

  const paths = resolveActivePaths(gitRoot);
  ensureHarnessReady(paths);
  const sessionDir = requireSession(paths, taskId);
  const fileMap = getSessionFileMap(sessionDir);

  if (!requestedFileRaw) {
    console.log(fileMap.brief);
    console.log(fileMap.state);
    console.log(fileMap.handoff);
    console.log(fileMap.next);
    console.log(fileMap.validation);
    return;
  }

  const requestedKey = requestedFileRaw.replace(/\.md$/i, '').toLowerCase();
  const targetPath = fileMap[requestedKey];
  if (!targetPath) {
    throw new Error('Unknown file. Use one of: handoff, state, brief, next, validation, decisions, log');
  }

  const editor = process.env.EDITOR;
  if (!editor) {
    console.log(targetPath);
    return;
  }

  try {
    execSync(`${editor} ${shellQuote(targetPath)}`, { stdio: 'inherit' });
  } catch {
    console.log(targetPath);
  }
}

function commandNote(gitRoot, args) {
  const taskId = args[0];
  if (!taskId) {
    throw new Error('Usage: atem note <task-id> "<note>" [--decision "<text>"] [--next "<text>"] [--validation "<text>"]');
  }

  let noteText = '';
  let decisionText = '';
  let nextText = '';
  let validationText = '';

  const freeformParts = [];
  for (let i = 1; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--decision') {
      decisionText = args[i + 1] || '';
      i += 1;
      continue;
    }
    if (token === '--next') {
      nextText = args[i + 1] || '';
      i += 1;
      continue;
    }
    if (token === '--validation') {
      validationText = args[i + 1] || '';
      i += 1;
      continue;
    }
    freeformParts.push(token);
  }
  noteText = freeformParts.join(' ').trim();

  if (!noteText && !decisionText && !nextText && !validationText) {
    throw new Error('Usage: atem note <task-id> "<note>" [--decision "<text>"] [--next "<text>"] [--validation "<text>"]');
  }

  const paths = resolveActivePaths(gitRoot);
  ensureHarnessReady(paths);
  const sessionDir = requireSession(paths, taskId);
  const files = getSessionFileMap(sessionDir);

  let logContent = readFile(files.log);
  const logParts = [];
  if (noteText) logParts.push(`note: ${noteText}`);
  if (decisionText) logParts.push(`decision: ${decisionText}`);
  if (nextText) logParts.push(`next: ${nextText}`);
  if (validationText) logParts.push(`validation: ${validationText}`);
  logContent = appendLog(logContent, logParts.join(' | '));
  writeFile(files.log, logContent);

  if (decisionText) {
    let decisions = readFile(files.decisions);
    decisions = appendBulletSection(
      decisions,
      '###',
      nowStamp(),
      `Decision: ${decisionText}`
    );
    writeFile(files.decisions, decisions);
  }

  if (nextText) {
    let next = readFile(files.next);
    const matches = next.match(/^\d+\.\s+/gm) || [];
    const nextNumber = matches.length + 1;
    next = `${next.trimEnd()}\n${next.endsWith('\n') ? '' : '\n'}${nextNumber}. ${nextText}\n`;
    writeFile(files.next, next);
  }

  if (validationText) {
    let validation = readFile(files.validation);
    validation = appendBulletSection(
      validation,
      '##',
      'Notes',
      `${nowStamp()} — ${validationText}`
    );
    writeFile(files.validation, validation);
  }

  console.log(`Noted updates for ${taskId}`);
}

function detectConvexProject(repoPath) {
  return fs.existsSync(path.join(repoPath, 'convex')) || fs.existsSync(path.join(repoPath, 'convex.json'));
}

function projectTemplateAgentRoles() {
  return `# Agent Roles
## Main Session
The main session is the integration, testing, and deployment authority.
The main session owns:
- main checkout
- final integration testing
- merge sequencing
- deployment commands
- schema deployment
- worktree cleanup after merge
The main session must not be used for normal feature implementation unless explicitly instructed.
## Worktree Session
A worktree session is a single-feature builder.
A worktree session owns:
- one task
- one branch
- one worktree
- one narrow implementation scope
- one ready-for-integration handoff
A worktree session must not:
- edit the main checkout
- run shared deployment commands
- depend on unmerged sibling worktrees
- modify unrelated features
- keep hidden state only in chat
`;
}

function projectTemplateWorktrees() {
  return `# Worktree Protocol
## Operating Model
- Main checkout is for integration, testing, and deployment.
- Feature implementation happens only in worktrees.
- One task gets one worktree.
- One worktree gets one branch.
- One branch should represent one PR.
- Branches should stay short-lived.
## Worktree Lifecycle
1. Create task.
2. Create worktree from \`origin/main\`.
3. Implement the smallest scoped change.
4. Rebase on \`origin/main\` before push.
5. Open PR or prepare merge.
6. Write ready-for-integration handoff.
7. Main session integrates and tests.
8. Delete worktree after merge.
## Rebase Discipline
Worktree sessions must rebase on \`origin/main\`:
- before pushing
- before opening a PR
- after main has merged any related change
- at least daily for active branches.
## Forbidden Actions
Worktree sessions must not:
- edit the main checkout
- run shared deployment commands
- depend on unmerged sibling branches
- make broad unrelated refactors
- keep hidden state only in chat
`;
}

function projectTemplateRules() {
  return `# Project ATEM Rules
## Source of Truth
The main branch is the source of truth.
All worktree branches must be based on \`origin/main\`.
## Main Checkout
The main checkout is for:
- integration
- testing
- deployment
- merge validation
It is not for normal feature implementation.
## Worktrees
Each worktree must have:
- one task
- one branch
- one owner/session
- one handoff
## Handoff
A worktree is not ready for integration until it has written a handoff under:
\`.harness/handoffs/<TASK-ID>/\`
## Session Discipline
Agents must keep durable state in files, not only in chat.
`;
}

function projectTemplateIntegrationQueue() {
  return `# Integration Queue
## Ready
_No tasks ready for integration._
## In Progress
_No integrations in progress._
## Completed
_No completed integrations yet._
`;
}

function projectTemplateConvex() {
  return `# Convex Rules
## Authority
Only the main session may run Convex commands that affect shared backend state.
Worktree sessions must not run:
- \`npx convex dev\`
- \`npx convex deploy\`
- any command that pushes schema/function changes to the shared Convex environment
## Schema Policy
Schema-first by default.
If a feature requires:
- required field changes
- index changes
- destructive migration
- shared query behavior changes
- data model changes that affect other worktrees
then create a schema PR first.
Flow:
1. Schema PR
2. Main session merges schema PR
3. Main session runs approved Convex command from main checkout
4. Feature worktree rebases on \`origin/main\`
5. Feature work continues
## Low-Risk Exception
Schema and feature code may ship together only if the schema change is:
- backward-compatible
- optional
- non-destructive
- easy to roll back
- low-risk for sibling worktrees
Even in this case, only the main session may run Convex commands after merge.
## Main Checkout Rule
Convex deploy/dev runs only from the main checkout.
Sibling worktrees must never push backend schema/function changes.
`;
}

function commandProjectInit(args) {
  const repoPath = getRepoArgOrThrow(args, 'Usage: atem project init --repo <repo-path> [--convex]');
  const repoRoot = getGitRepoRoot(repoPath);
  if (!repoRoot) {
    throw new Error(`Error: target repository is not a git repository: ${repoPath}`);
  }
  const projectPaths = getProjectPaths(repoRoot);
  const convexEnabled = hasFlag(args, '--convex') || detectConvexProject(repoRoot);

  ensureProjectHarnessDir(projectPaths);
  ensureMarkdownFile(projectPaths.projectRulesFile, projectTemplateRules());
  ensureMarkdownFile(projectPaths.agentRolesFile, projectTemplateAgentRoles());
  ensureMarkdownFile(projectPaths.worktreesFile, projectTemplateWorktrees());
  ensureMarkdownFile(projectPaths.integrationQueueFile, projectTemplateIntegrationQueue());
  if (convexEnabled) {
    ensureMarkdownFile(projectPaths.convexFile, projectTemplateConvex());
  }

  console.log(`Initialized project handoff store: ${projectPaths.projectHarnessDir}`);
  if (convexEnabled) {
    console.log('Convex rules enabled.');
  }
}

function commandProjectInstructions(args) {
  const repoPath = getRepoArgOrThrow(args, 'Usage: atem project instructions --repo <repo-path>');
  const projectPaths = getProjectPaths(repoPath);
  const convexEnabled = fs.existsSync(projectPaths.convexFile) || detectConvexProject(repoPath);

  const lines = [
    '# ATEM Project Agent Instructions',
    '## Main Rule',
    'Do not use the main checkout for feature implementation.',
    '## Worktree Rule',
    'Every implementation task must run in its own worktree.',
    '## Handoff Rule',
    'Before stopping, update:',
    '- `.harness/handoffs/<TASK-ID>/worktree-handoff.md`',
    '- `.harness/handoffs/<TASK-ID>/test-plan.md`',
    '- `.harness/handoffs/<TASK-ID>/schema-impact.md`',
    '## Ready Rule',
    'A worktree is not ready until it has a completed handoff, test plan, and schema-impact classification.',
    '## Integration Rule',
    'Only the main session integrates, tests, deploys, and cleans up.',
  ];
  if (convexEnabled) {
    lines.push('## Convex Rule');
    lines.push('Do not run Convex dev/deploy from worktrees.');
    lines.push('Only the main session may run Convex commands.');
  }
  console.log(lines.join('\n'));
}

function worktreeTemplateHandoff(taskId, branch, worktreePath) {
  return `# Worktree Handoff
## Task
${taskId}
## Type
implementation
## Branch
${branch}
## Worktree
${worktreePath}
## Base
origin/main
## Status
in-progress
## What changed
Nothing yet.
## What main should test
To be defined.
## Schema impact
unknown
## Deployment impact
unknown
## Commands run
None yet.
## Known risks
None yet.
## Main session next step
Wait until this task is marked ready for integration.
`;
}

function worktreeTemplateTestPlan(taskId) {
  return `# Test Plan
## Task
${taskId}
## Manual Test Steps
_To be completed by worktree session._
## Automated Commands
_To be completed by worktree session._
## Main Session Validation
_To be completed by main session._
`;
}

function worktreeTemplateSchemaImpact(taskId) {
  return `# Schema Impact
## Task
${taskId}
## Classification
unknown
Allowed values:
- none
- backward-compatible
- schema-first-required
- migration-required
## Details
_To be completed by worktree session._
## Deployment Action Required
unknown
Allowed values:
- none
- main-dev-once-required
- deploy-required
`;
}

function worktreeTemplateMergeNotes(taskId, branch) {
  return `# Merge Notes
## Task
${taskId}
## PR
_Not opened yet._
## Branch
${branch}
## Rebase Status
_Not checked yet._
## Merge Notes
_To be completed._
`;
}

function worktreeTemplateIntegrationResult(taskId) {
  return `# Integration Result
## Task
${taskId}
## Status
not-integrated
## Main Session Validation
_Not run yet._
## Result
_Not available yet._
## Follow-Up
_None yet._
`;
}

function commandWorktreeStart(args) {
  const taskId = args[0];
  if (!taskId) {
    throw new Error('Usage: atem worktree start <task-id> --repo <repo-path> --branch <branch-name> [--path <worktree-path>]');
  }
  const repoPath = getRepoArgOrThrow(args, 'Usage: atem worktree start <task-id> --repo <repo-path> --branch <branch-name> [--path <worktree-path>]');
  const branch = setNamedArg(args, '--branch');
  if (!branch) {
    throw new Error('Usage: atem worktree start <task-id> --repo <repo-path> --branch <branch-name> [--path <worktree-path>]');
  }
  const worktreePath = setNamedArg(args, '--path')
    ? path.resolve(setNamedArg(args, '--path'))
    : path.join(path.dirname(repoPath), `${path.basename(repoPath)}-${branch.replace(/[^\w.-]+/g, '-')}`);

  const repoRoot = getGitRepoRoot(repoPath);
  if (!repoRoot) {
    throw new Error(`Error: target repository is not a git repository: ${repoPath}`);
  }

  const projectPaths = getProjectPaths(repoRoot);
  if (!fs.existsSync(projectPaths.projectHarnessDir)) {
    throw new Error(`Project handoff store not initialized: ${projectPaths.projectHarnessDir}`);
  }

  execFileSync('git', ['-C', repoRoot, 'fetch', 'origin'], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '-b', branch, worktreePath, 'origin/main'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const handoffDir = path.join(projectPaths.handoffsDir, taskId);
  ensureDir(handoffDir);
  ensureMarkdownFile(path.join(handoffDir, 'worktree-handoff.md'), worktreeTemplateHandoff(taskId, branch, worktreePath));
  ensureMarkdownFile(path.join(handoffDir, 'test-plan.md'), worktreeTemplateTestPlan(taskId));
  ensureMarkdownFile(path.join(handoffDir, 'schema-impact.md'), worktreeTemplateSchemaImpact(taskId));
  ensureMarkdownFile(path.join(handoffDir, 'merge-notes.md'), worktreeTemplateMergeNotes(taskId, branch));
  ensureMarkdownFile(path.join(handoffDir, 'integration-result.md'), worktreeTemplateIntegrationResult(taskId));

  const globalPaths = getGlobalPaths();
  const globalSessionDir = getSessionDir(globalPaths, taskId);
  if (fs.existsSync(globalSessionDir)) {
    const files = getSessionFileMap(globalSessionDir);
    let state = readFile(files.state);
    state = setSection(state, 'Target Repository', repoRoot);
    state = setSection(state, 'Current Summary', `Worktree started on branch ${branch}: ${worktreePath}`);
    state = setSection(state, 'Last Updated', nowStamp());
    writeFile(files.state, state);
    let handoff = readFile(files.handoff);
    handoff = setSection(handoff, 'Current Status', `Worktree initialized on ${branch}`);
    writeFile(files.handoff, handoff);
    let log = readFile(files.log);
    log = appendLog(log, `Started worktree.\n- Branch: ${branch}\n- Worktree: ${worktreePath}\n- Base: origin/main\n- Repo: ${repoRoot}`);
    writeFile(files.log, log);
  }

  console.log(`Worktree created for ${taskId}`);
  console.log(`- repo: ${repoRoot}`);
  console.log(`- branch: ${branch}`);
  console.log(`- path: ${worktreePath}`);
}

function upsertReadyQueueEntry(queueContent, taskId, entryLines) {
  let readySection = getSection(queueContent, 'Ready');
  if (!readySection || readySection === '_No tasks ready for integration._') {
    readySection = '';
  }
  const blockRegex = new RegExp(`(^### ${escapeRegex(taskId)}[\\s\\S]*?)(?=\\n### |$)`, 'm');
  readySection = readySection.replace(blockRegex, '').trim();
  const newBlock = [`### ${taskId}`, ...entryLines].join('\n');
  readySection = readySection ? `${readySection}\n\n${newBlock}` : newBlock;
  return setSection(queueContent, 'Ready', readySection);
}

function commandReady(gitRoot, args) {
  const taskId = args[0];
  if (!taskId) {
    throw new Error('Usage: atem ready <task-id> --repo <repo-path> [--pr <url>]');
  }
  const repoPath = getRepoArgOrThrow(args, 'Usage: atem ready <task-id> --repo <repo-path> [--pr <url>]');
  if (!getGitRepoRoot(repoPath)) {
    throw new Error(`Error: target repository is not a git repository: ${repoPath}`);
  }
  const prUrl = setNamedArg(args, '--pr');
  const projectPaths = getProjectPaths(repoPath);
  const handoffDir = path.join(projectPaths.handoffsDir, taskId);
  const required = ['worktree-handoff.md', 'test-plan.md', 'schema-impact.md', 'merge-notes.md'];
  for (const name of required) {
    if (!fs.existsSync(path.join(handoffDir, name))) {
      throw new Error(`Missing required file for ready: ${path.join(handoffDir, name)}`);
    }
  }

  const worktreeHandoffPath = path.join(handoffDir, 'worktree-handoff.md');
  let worktreeHandoff = readFile(worktreeHandoffPath);
  worktreeHandoff = setSection(worktreeHandoff, 'Status', 'ready-for-integration');
  writeFile(worktreeHandoffPath, worktreeHandoff);

  const mergeNotesPath = path.join(handoffDir, 'merge-notes.md');
  let mergeNotes = readFile(mergeNotesPath);
  if (prUrl) {
    mergeNotes = setSection(mergeNotes, 'PR', prUrl);
  }
  writeFile(mergeNotesPath, mergeNotes);

  const schemaImpact = getSection(readFile(path.join(handoffDir, 'schema-impact.md')), 'Classification') || 'unknown';
  const deploymentImpact = getSection(readFile(path.join(handoffDir, 'schema-impact.md')), 'Deployment Action Required') || 'unknown';
  const branch = getSection(worktreeHandoff, 'Branch') || 'unknown';
  const entryLines = [
    `- Branch: ${branch}`,
    `- PR: ${prUrl || getSection(mergeNotes, 'PR') || '_Not opened yet._'}`,
    `- Schema impact: ${schemaImpact}`,
    `- Deployment impact: ${deploymentImpact}`,
    '- Risk: low',
    `- Ready since: ${nowStamp()}`,
  ];

  let queue = fs.existsSync(projectPaths.integrationQueueFile)
    ? readFile(projectPaths.integrationQueueFile)
    : projectTemplateIntegrationQueue();
  queue = upsertReadyQueueEntry(queue, taskId, entryLines);
  writeFile(projectPaths.integrationQueueFile, queue);

  const globalSessionDir = getSessionDir(getGlobalPaths(), taskId);
  if (fs.existsSync(globalSessionDir)) {
    const files = getSessionFileMap(globalSessionDir);
    let handoff = readFile(files.handoff);
    handoff = setSection(handoff, 'Current Status', 'ready-for-integration');
    handoff = setSection(handoff, 'Next Recommended Action', 'Main session should run `atem integrate <task-id> --repo <repo-path>`.');
    writeFile(files.handoff, handoff);
    let next = readFile(files.next);
    next = `${next.trimEnd()}\n${next.endsWith('\n') ? '' : '\n'}1. Integrate ${taskId} from project queue.\n`;
    writeFile(files.next, next);
  }

  console.log(`Marked ${taskId} ready for integration.`);
}

function commandIntegrate(args) {
  const taskId = args[0];
  if (!taskId) {
    throw new Error('Usage: atem integrate <task-id> --repo <repo-path>');
  }
  const repoPath = getRepoArgOrThrow(args, 'Usage: atem integrate <task-id> --repo <repo-path>');
  const projectPaths = getProjectPaths(repoPath);
  const handoffDir = path.join(projectPaths.handoffsDir, taskId);
  if (!fs.existsSync(handoffDir)) {
    throw new Error(`Missing handoff folder: ${handoffDir}`);
  }

  const worktreeHandoffPath = path.join(handoffDir, 'worktree-handoff.md');
  const mergeNotesPath = path.join(handoffDir, 'merge-notes.md');
  const schemaImpactPath = path.join(handoffDir, 'schema-impact.md');
  const integrationResultPath = path.join(handoffDir, 'integration-result.md');

  const worktreeHandoff = readFile(worktreeHandoffPath);
  const mergeNotes = readFile(mergeNotesPath);
  const schemaImpact = readFile(schemaImpactPath);

  const branch = getSection(worktreeHandoff, 'Branch') || 'unknown';
  const pr = getSection(mergeNotes, 'PR') || '_Not opened yet._';
  const schemaClass = firstNonEmptyLine(getSection(schemaImpact, 'Classification')) || 'unknown';
  const deployAction = firstNonEmptyLine(getSection(schemaImpact, 'Deployment Action Required')) || 'unknown';

  const checklist = [
    `# Integration Checklist for ${taskId}`,
    '## Branch',
    branch,
    '## PR',
    pr,
    '## Schema Impact',
    schemaClass,
    '## Deployment Impact',
    deployAction,
    '## Main Session Steps',
    '1. Confirm main checkout is clean.',
    '2. Pull latest main.',
    '3. Review PR.',
    '4. Merge PR.',
    '5. Run project tests.',
    '6. If deployment impact is required, run approved deployment command from main checkout.',
    '7. Update integration-result.md.',
    '8. Delete worktree after merge.',
    '',
  ].join('\n');

  writeFile(integrationResultPath, checklist);
  console.log(checklist);
}

function commandProjectDoctor(args) {
  const repoPath = getRepoArgOrThrow(args, 'Usage: atem project doctor --repo <repo-path>');
  if (!getGitRepoRoot(repoPath)) {
    throw new Error(`Error: target repository is not a git repository: ${repoPath}`);
  }
  const projectPaths = getProjectPaths(repoPath);
  console.log(`${PRODUCT_NAME} project doctor`);
  console.log(`Repository: ${repoPath}`);

  const report = (level, message) => console.log(`[${level}] ${message}`);
  if (!fs.existsSync(projectPaths.projectHarnessDir)) {
    report('FAIL', `project handoff store missing: ${projectPaths.projectHarnessDir}`);
    return;
  }
  report('OK', `project handoff store exists: ${projectPaths.projectHarnessDir}`);

  for (const fileName of PROJECT_REQUIRED_FILES) {
    const filePath = path.join(projectPaths.projectHarnessDir, fileName);
    if (fs.existsSync(filePath)) report('OK', `${fileName} present`);
    else report('FAIL', `${fileName} missing`);
  }
  if (fs.existsSync(projectPaths.handoffsDir)) {
    report('OK', 'handoffs directory present');
  } else {
    report('FAIL', 'handoffs directory missing');
    return;
  }

  const queue = fs.existsSync(projectPaths.integrationQueueFile)
    ? readFile(projectPaths.integrationQueueFile)
    : '';
  const readySection = getSection(queue, 'Ready');

  const handoffTasks = fs.readdirSync(projectPaths.handoffsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const repoRoot = getGitRepoRoot(repoPath);
  for (const taskId of handoffTasks) {
    const handoffDir = path.join(projectPaths.handoffsDir, taskId);
    const needed = ['worktree-handoff.md', 'test-plan.md', 'schema-impact.md', 'merge-notes.md', 'integration-result.md'];
    for (const name of needed) {
      if (!fs.existsSync(path.join(handoffDir, name))) {
        report('FAIL', `${taskId}: missing ${name}`);
      }
    }

    const worktreeHandoffPath = path.join(handoffDir, 'worktree-handoff.md');
    if (!fs.existsSync(worktreeHandoffPath)) continue;
    const wh = readFile(worktreeHandoffPath);
    const status = getSection(wh, 'Status');
    const worktreePath = getSection(wh, 'Worktree');
    const branch = getSection(wh, 'Branch');

    if (worktreePath && !fs.existsSync(worktreePath)) {
      report('WARN', `${taskId}: worktree path missing on disk: ${worktreePath}`);
    }
    if (repoRoot && branch) {
      const exists = gitCommandSucceeds(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      if (!exists) {
        report('WARN', `${taskId}: branch not found locally: ${branch}`);
      } else {
        const aheadBehind = runGitCommand(repoRoot, ['rev-list', '--left-right', '--count', `${branch}...origin/main`]).trim();
        const parts = aheadBehind.split(/\s+/);
        if (parts.length >= 2) {
          const behind = Number(parts[1]);
          if (Number.isFinite(behind) && behind > 0) {
            report('WARN', `${taskId}: branch ${branch} is behind origin/main by ${behind} commit(s)`);
          }
        }
      }
    }

    const schemaImpactPath = path.join(handoffDir, 'schema-impact.md');
    if (fs.existsSync(schemaImpactPath)) {
      const schema = readFile(schemaImpactPath);
      const cls = getSection(schema, 'Classification') || 'unknown';
      const dep = getSection(schema, 'Deployment Action Required') || 'unknown';
      if (cls === 'unknown') report('WARN', `${taskId}: schema impact is unknown`);
      if (dep === 'unknown') report('WARN', `${taskId}: deployment impact is unknown`);
    }

    if (status === 'ready-for-integration') {
      if (!readySection.includes(`### ${taskId}`)) {
        report('WARN', `${taskId}: marked ready but missing from integration queue`);
      }
    }
  }

  const readyBlocks = readySection
    .split('\n### ')
    .map((block, index) => (index === 0 ? block : `### ${block}`))
    .filter((block) => block.trim().startsWith('### '));
  for (const block of readyBlocks) {
    const header = block.split('\n')[0].trim();
    const taskId = header.replace(/^###\s+/, '');
    const readySinceLine = block.split('\n').find((line) => line.trim().startsWith('- Ready since:'));
    if (!readySinceLine) continue;
    const raw = readySinceLine.split(':').slice(1).join(':').trim();
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) continue;
    const hoursOld = (Date.now() - parsed.getTime()) / (1000 * 60 * 60);
    if (hoursOld > 24) {
      report('WARN', `${taskId}: ready for ${Math.floor(hoursOld)}h; consider integrating or reprioritizing`);
    }
  }
}

function commandProject(args) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'init':
      commandProjectInit(rest);
      break;
    case 'instructions':
      commandProjectInstructions(rest);
      break;
    case 'doctor':
      commandProjectDoctor(rest);
      break;
    default:
      throw new Error('Usage: atem project <init|instructions|doctor> --repo <repo-path>');
  }
}

function commandWorktree(args) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'start') {
    commandWorktreeStart(rest);
    return;
  }
  throw new Error('Usage: atem worktree start <task-id> --repo <repo-path> --branch <branch-name> [--path <worktree-path>]');
}

function printUsage() {
  console.log(`${PRODUCT_NAME}
${PRODUCT_TAGLINE}

Usage:
  atem <command> [options]

Global session commands:
  status
    Show machine-wide provider activity + active ATEM session context.
    Compact by default; pass --verbose/-v for per-PID details + full goal text.
    Optional: --repo <repo-path> to scope detected activity to a repository path.
  session
    Print the synthetic session id for the current cwd (pipe-friendly).
    Use with handoff: \`atem handoff "$(atem session)" --to codex\`.
    Flags: --all (list every match), --json, --verbose (table), --repo <path>.
  init
    Initialize handoff store files (global by default, repo when ATEM_HARNESS_MODE=repo).
  start
    Create a new task session with task type + target repository.
  adopt
    Capture current provider/process activity into the task's state.md.
  route
    Update session routing state (provider + target repo) without printing prompt.
  handoff
    Generate provider-ready handoff prompt from current session files.
  guardrails convex <inventory|audit|status>
    Convex Guard: which repositories hold Convex code, what each holds itself
    to, and where they drift from the standard. Read-only.
  snapshot
    Capture git/session checkpoint under sessions/<TASK>/snapshots/<timestamp>/.
  doctor
    Validate global session health (files, task type, provider state, drift).
  clean
    Normalize/repair a task's state files and deduplicate provider sections.
  open
    Print or open key task files (brief/state/handoff/next/validation/etc).
  note
    Append timestamped task notes and optional decision/next/validation updates.
  instructions
    Print provider contract instructions for Claude/Codex/Cursor/etc.
  goals
    Read repo docs for goals and report goal/task drift.

Project/worktree commands:
  project init
    Initialize <repo>/.harness project handoff store and templates.
  project instructions
    Print project-level agent instructions (main vs worktree discipline).
  project doctor
    Validate project handoff health, queue integrity, and worktree metadata.
  worktree start
    Create feature worktree from origin/main and task handoff templates.
  ready
    Mark task ready-for-integration and upsert integration queue entry.
  integrate
    Print/write integration checklist (no auto-merge, no auto-deploy).

Common command forms:
  atem status [--repo <repo-path>] [--all] [--verbose]
  atem session [--repo <repo-path>] [--all] [--json] [--verbose]
  atem start "<task>" [--type <type>] [--repo <repo-path>]
  atem adopt <task-id>
  atem route <task-id> --to <provider> [--repo <repo-path>]
  atem handoff <task-id> [--to <provider>] [--repo <repo-path>]
  atem snapshot <task-id> [--repo <repo-path>]
  atem note <task-id> "<note>" [--decision "<text>"] [--next "<text>"] [--validation "<text>"]
  atem goals [--repo <repo-path>] [--files <a,b,c>] [--json]
  atem web [--port <n>] [--no-open]
  atem project init --repo <repo-path> [--convex]
  atem worktree start <task-id> --repo <repo-path> --branch <branch-name> [--path <worktree-path>]
  atem ready <task-id> --repo <repo-path> [--pr <url>]
  atem integrate <task-id> --repo <repo-path>

Quick workflow (global session handoff):
  1. atem start "Fix bug X" --type implementation --repo /path/to/repo
  2. atem adopt TASK-001
  3. atem route TASK-001 --to codex --repo /path/to/repo
  4. atem handoff TASK-001
  5. atem snapshot TASK-001
  6. atem doctor

Quick workflow (project/worktree):
  1. atem project init --repo /path/to/repo
  2. atem worktree start TASK-123 --repo /path/to/repo --branch task/example
  3. atem ready TASK-123 --repo /path/to/repo --pr <url>
  4. atem integrate TASK-123 --repo /path/to/repo
  5. atem project doctor --repo /path/to/repo

Task types:
  tracker, implementation, investigation, validation, documentation, review

Naming note:
  - CLI command remains \`atem\` during transition.
  - Product name is ${PRODUCT_NAME}.
  - ATEM state directory: ${GLOBAL_STATE_DIR}
`);
}

function main(argv) {
  try {
    const [command, ...args] = argv;
    if (!command || command === '--help' || command === '-h' || command === 'help') {
      printUsage();
      return;
    }

    const gitRoot = findGitRoot();

    switch (command) {
      case 'init':
        commandInit(gitRoot);
        break;
      case 'migrate-tasks':
        commandMigrateTasks(gitRoot, args);
        break;
      case 'start':
        commandStart(gitRoot, args);
        break;
      case 'status':
        commandStatus(gitRoot, args);
        break;
      case 'session':
        commandSession(gitRoot, args);
        break;
      case 'route':
        commandRoute(gitRoot, args);
        break;
      case 'adopt':
        commandAdopt(gitRoot, args);
        break;
      case 'handoff':
        commandHandoff(gitRoot, args);
        break;
      case 'close':
        commandClose(gitRoot, args);
        break;
      case 'doctor':
        commandDoctor(gitRoot);
        break;
      case 'clean':
        commandClean(gitRoot, args);
        break;
      case 'instructions':
        commandInstructions(gitRoot, args);
        break;
      case 'open':
        commandOpen(gitRoot, args);
        break;
      case 'note':
        commandNote(gitRoot, args);
        break;
      case 'snapshot':
        commandSnapshot(gitRoot, args);
        break;
      case 'project':
        commandProject(args);
        break;
      case 'worktree':
        commandWorktree(args);
        break;
      case 'ready':
        commandReady(gitRoot, args);
        break;
      case 'integrate':
        commandIntegrate(args);
        break;
      case 'adapter':
        commandAdapter(args);
        break;
      case 'archive':
        commandArchive(gitRoot, args);
        break;
      case 'repos':
        commandRepos(args);
        break;
      case 'snapshot-diff':
        commandSnapshotDiff(gitRoot, args);
        break;
      case 'goals':
        commandGoals(gitRoot, args);
        break;
      case 'web':
        commandWeb(gitRoot, args);
        break;
      case 'ingest-omp':
        commandIngestOmp(gitRoot, args);
        break;
      case 'resolve':
        commandResolve(gitRoot, args);
        break;
      case 'url':
        commandUrl(gitRoot, args);
        break;
      case 'mcp-server':
        // F.2: stdio MCP server. Doesn't return until stdin closes.
        return require('./mcp-server.js').run();
      case 'install':
        commandInstall(args);
        break;
      case 'uninstall':
        commandUninstall(args);
        break;
      case 'recover':
        commandRecover(gitRoot, args);
        break;
      case 'rollback':
        commandRollback(gitRoot, args);
        break;
      case 'reconcile':
        commandReconcile(gitRoot, args);
        break;
      case 'guardrails':
        return commandGuardrails(args);
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  buildHandoffPrompt,
  // Re-exports for adapters (Workstream 3)
  resolveActivePaths,
  requireSession,
  getSessionFileMap,
  readFile,
  writeFile,
  getSection,
  setSection,
  appendLog,
  parseFrontmatter,
  buildFrontmatter,
  nowStamp,
  normalizeTaskType,
  isValidTaskType,
  PROVIDERS,
  TASK_TYPES,
  findGitRoot,
  // Re-exports for recovery (Workstream 7)
  syncStateFrontmatter,
  removeDuplicateSectionBlocks,
  sectionCount,
  ensureDir,
  openInBrowser,
};
