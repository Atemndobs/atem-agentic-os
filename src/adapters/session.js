// SessionAdapter — shared read/write API over ATEM session files.
// Workstream 3: lightweight, NOT autonomous. Providers use this to
// read state, update state, and standardize lifecycle behavior.

const fs = require('node:fs');
const {
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
  findGitRoot,
} = require('../cli.js');

const SCHEMA_VERSION = 'atem.session.v1';

function locate(taskId) {
  const gitRoot = findGitRoot();
  const paths = resolveActivePaths(gitRoot);
  const sessionDir = requireSession(paths, taskId);
  const files = getSessionFileMap(sessionDir);
  return { paths, sessionDir, files };
}

function readSession(taskId) {
  const { files } = locate(taskId);
  const brief = fs.existsSync(files.brief) ? readFile(files.brief) : '';
  const state = fs.existsSync(files.state) ? readFile(files.state) : '';
  const briefFm = parseFrontmatter(brief).data;
  const stateFm = parseFrontmatter(state).data;
  const pick = (key, fallbackSection) => stateFm[key] || briefFm[key] || getSection(state, fallbackSection) || getSection(brief, fallbackSection) || '';
  return {
    task_id: taskId,
    schema: stateFm.schema || briefFm.schema || '',
    task_type: normalizeTaskType(pick('task_type', 'Task Type')),
    status: pick('status', 'Status') || 'active',
    provider: pick('provider', 'Current Provider') || 'manual',
    repo: pick('repo', 'Primary Repository') || '',
    target_repo: pick('target_repo', 'Target Repository') || '',
    title: getSection(brief, 'Title') || '',
    goal: getSection(brief, 'Goal') || '',
    summary: getSection(state, 'Current Summary') || '',
  };
}

// Patch a subset of frontmatter+sections atomically. Caller passes the
// new values; we update both frontmatter (machine-readable) and the
// corresponding `## Heading` section (human-readable).
function updateSession(taskId, patch) {
  const { files } = locate(taskId);
  let state = readFile(files.state);
  const { data: fm } = parseFrontmatter(state);

  const fmMap = {
    task_type: 'Task Type',
    status: 'Status',
    provider: 'Current Provider',
    repo: 'Primary Repository',
    target_repo: 'Target Repository',
    summary: 'Current Summary',
  };

  for (const [key, section] of Object.entries(fmMap)) {
    if (patch[key] === undefined) continue;
    const value = String(patch[key]);
    if (key === 'task_type' && !isValidTaskType(value)) {
      throw new Error(`Invalid task_type: ${value}`);
    }
    if (key === 'provider' && !PROVIDERS.has(value)) {
      throw new Error(`Invalid provider: ${value}`);
    }
    fm[key] = value;
    state = setSection(state, section, value);
  }
  fm.schema = SCHEMA_VERSION;
  fm.task_id = taskId;

  // Rebuild frontmatter at the top
  const { body } = parseFrontmatter(state);
  state = buildFrontmatter(fm) + body;
  state = setSection(state, 'Last Updated', nowStamp());
  writeFile(files.state, state);
  return readSession(taskId);
}

function logEvent(taskId, message) {
  const { files } = locate(taskId);
  const content = fs.existsSync(files.log) ? readFile(files.log) : '# Session Log\n';
  writeFile(files.log, appendLog(content, message));
}

function recordDecision(taskId, { decision, reason = '', impact = '' }) {
  if (!decision) throw new Error('recordDecision requires a decision string');
  const { files } = locate(taskId);
  const stamp = nowStamp();
  const block = `\n### ${stamp}\n- Decision: ${decision}\n- Reason: ${reason || 'unspecified'}\n- Impact: ${impact || 'unspecified'}\n`;
  const content = fs.existsSync(files.decisions) ? readFile(files.decisions) : '# Decisions\n\n## Decision Log\n';
  writeFile(files.decisions, content + block);
  logEvent(taskId, `Decision: ${decision}`);
}

function recordValidation(taskId, { command, result, failure = '' }) {
  if (!command) throw new Error('recordValidation requires a command');
  const { files } = locate(taskId);
  const stamp = nowStamp();
  const block = [
    `\n### ${stamp}`,
    `- Command: ${command}`,
    `- Result: ${result || 'unspecified'}`,
    failure ? `- Failure: ${failure}` : '',
  ].filter(Boolean).join('\n') + '\n';
  const content = fs.existsSync(files.validation) ? readFile(files.validation) : '# Validation\n';
  writeFile(files.validation, content + block);
  logEvent(taskId, `Validation: ${command} → ${result || 'unspecified'}`);
}

function markFilesTouched(taskId, filesTouched) {
  if (!Array.isArray(filesTouched) || filesTouched.length === 0) return;
  const { files } = locate(taskId);
  let state = readFile(files.state);
  const existing = getSection(state, 'Files Touched');
  const lines = (existing && existing !== 'None yet.' ? existing.split('\n') : [])
    .map((l) => l.replace(/^- /, '').trim())
    .filter(Boolean);
  for (const f of filesTouched) {
    if (!lines.includes(f)) lines.push(f);
  }
  const value = lines.length ? lines.map((f) => `- ${f}`).join('\n') : 'None yet.';
  state = setSection(state, 'Files Touched', value);
  state = setSection(state, 'Last Updated', nowStamp());
  writeFile(files.state, state);
}

module.exports = {
  SCHEMA_VERSION,
  readSession,
  updateSession,
  logEvent,
  recordDecision,
  recordValidation,
  markFilesTouched,
};
