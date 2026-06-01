// omp (oh-my-pi) provider adapter.
//
// Read-only on omp's side. We never write to ~/.omp; we only:
//   - locate omp's session jsonl for a given cwd or session id
//   - parse the header + entries
//   - distill a structured "current state" for ATEM session files
//
// The on-disk contract is documented in docs/research/omp-session-layout.md.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

// We deliberately mirror omp's encoding (not import it). See §1.2 of the
// research doc. omp's home-relative form replaces /,\,: with '-' and prefixes
// with '-'. The legacy absolute form wraps the dashed path in '--…--'.

function getAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.omp', 'agent');
}

function getSessionsRoot() {
  return path.join(getAgentDir(), 'sessions');
}

function encodeHomeRelative(prefix, root, cwd) {
  const rel = path.relative(root, cwd).replace(/[/\\:]/g, '-');
  if (!rel) return prefix;
  return prefix.endsWith('-') ? `${prefix}${rel}` : `${prefix}-${rel}`;
}

function encodeLegacyAbsolute(cwd) {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

function encodeSessionDirName(cwd) {
  const resolved = path.resolve(cwd);
  const home = os.homedir();
  const tmp = os.tmpdir();
  if (resolved === home || resolved.startsWith(home + path.sep)) {
    return encodeHomeRelative('-', home, resolved);
  }
  if (resolved === tmp || resolved.startsWith(tmp + path.sep)) {
    return encodeHomeRelative('-tmp', tmp, resolved);
  }
  return encodeLegacyAbsolute(resolved);
}

function readHeader(sessionFile) {
  try {
    const fd = fs.openSync(sessionFile, 'r');
    const buf = Buffer.alloc(8192);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const chunk = buf.slice(0, bytes).toString('utf8');
    const firstLine = chunk.split('\n', 1)[0];
    if (!firstLine || !firstLine.trim()) return null;
    const parsed = JSON.parse(firstLine);
    return parsed && parsed.type === 'session' ? parsed : null;
  } catch {
    return null;
  }
}

async function readEntries(sessionFile) {
  const entries = [];
  const stream = fs.createReadStream(sessionFile, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let isFirst = true;
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (isFirst) { isFirst = false; continue; }
    try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return entries;
}

function listSessionFilesForCwd(cwd) {
  // The encoded dir name is lossy. We try the canonical encoding first,
  // then also scan every dir and accept any whose header.cwd matches.
  const root = getSessionsRoot();
  if (!fs.existsSync(root)) return [];
  const matches = [];
  const wantedEncoded = encodeSessionDirName(cwd);
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  for (const dirEnt of dirs) {
    if (!dirEnt.isDirectory()) continue;
    const subdir = path.join(root, dirEnt.name);
    let names;
    try { names = fs.readdirSync(subdir); } catch { continue; }
    const isCanonical = dirEnt.name === wantedEncoded;
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(subdir, name);
      if (isCanonical) {
        matches.push(file);
        continue;
      }
      // Fallback: confirm via header.cwd.
      const header = readHeader(file);
      if (header && header.cwd && path.resolve(header.cwd) === path.resolve(cwd)) {
        matches.push(file);
      }
    }
  }
  // Sort newest first by mtime.
  return matches.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function findLatestSessionFile(cwd) {
  const files = listSessionFilesForCwd(cwd);
  return files[0] || null;
}

function findSessionFileById(sessionId) {
  const root = getSessionsRoot();
  if (!fs.existsSync(root)) return null;
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const dirEnt of dirs) {
    if (!dirEnt.isDirectory()) continue;
    const candidate = path.join(root, dirEnt.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ---- distillation ---------------------------------------------------------
//
// See §2.3 of the research doc. We do a single linear pass and keep the
// most recent entry of each interesting kind.

function firstTextBlock(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block) continue;
      if (typeof block.text === 'string') return block.text;
      if (typeof block.content === 'string') return block.content;
    }
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return '';
}

function firstParagraph(text) {
  if (!text) return '';
  const trimmed = String(text).trim();
  if (!trimmed) return '';
  const para = trimmed.split(/\n\s*\n/)[0] || trimmed;
  return para.length > 600 ? para.slice(0, 600) + '…' : para;
}

async function distillSession(sessionFile) {
  const header = readHeader(sessionFile);
  if (!header) return null;
  const entries = await readEntries(sessionFile);

  let firstTask = '';
  let lastUserMessage = '';
  let lastAssistantText = '';
  let lastModel = '';
  let currentMode = 'none';
  let latestCompactionSummary = '';
  let toolsAtInit = [];
  let toolCallsInFlight = 0;
  let labelMoments = [];

  for (const e of entries) {
    if (!e || !e.type) continue;
    switch (e.type) {
      case 'session_init':
        if (!firstTask && typeof e.task === 'string') firstTask = e.task;
        if (Array.isArray(e.tools)) toolsAtInit = e.tools;
        break;
      case 'model_change':
        if (typeof e.model === 'string') lastModel = e.model;
        break;
      case 'mode_change':
        if (typeof e.mode === 'string') currentMode = e.mode;
        break;
      case 'compaction':
        if (typeof e.summary === 'string') latestCompactionSummary = e.summary;
        break;
      case 'label':
        if (e.label) labelMoments.push({ id: e.id, label: e.label, timestamp: e.timestamp });
        break;
      case 'message': {
        const msg = e.message || {};
        const role = msg.role;
        const text = firstTextBlock(msg.content);
        if (role === 'user' && text) {
          if (!firstTask) firstTask = text;
          lastUserMessage = text;
          toolCallsInFlight = 0;
        } else if (role === 'assistant' && text) {
          lastAssistantText = text;
        }
        // Track tool-call mid-flight signals if the content array carries them.
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (!block) continue;
            if (block.type === 'tool_use' || block.type === 'tool_call') toolCallsInFlight += 1;
            if (block.type === 'tool_result') toolCallsInFlight = Math.max(0, toolCallsInFlight - 1);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  const summary = latestCompactionSummary || firstParagraph(lastAssistantText);
  const paused = toolCallsInFlight > 0;

  return {
    sessionId: header.id,
    sessionFile,
    title: header.title || '',
    cwd: header.cwd || '',
    startedAt: header.timestamp || '',
    model: lastModel,
    mode: currentMode,
    firstTask: firstTask || '',
    summary,
    lastUserMessage: lastUserMessage || '',
    lastAssistantText: lastAssistantText || '',
    tools: toolsAtInit,
    pausedMidTool: paused,
    labels: labelMoments.slice(-10),
  };
}

// Synchronous wrapper for the common "just give me the latest session" case
// used in CLI commands. Reads the whole file once.
function distillSessionSync(sessionFile) {
  const header = readHeader(sessionFile);
  if (!header) return null;
  let raw;
  try { raw = fs.readFileSync(sessionFile, 'utf8'); } catch { return null; }
  const lines = raw.split('\n').filter(Boolean);
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    try { entries.push(JSON.parse(lines[i])); } catch { /* skip */ }
  }
  // Reuse logic by reconstructing the same shape `distillSession` builds.
  // We do the same scan inline rather than re-parsing.
  let firstTask = '';
  let lastUserMessage = '';
  let lastAssistantText = '';
  let lastModel = '';
  let currentMode = 'none';
  let latestCompactionSummary = '';
  let toolsAtInit = [];
  let toolCallsInFlight = 0;
  let labelMoments = [];
  for (const e of entries) {
    if (!e || !e.type) continue;
    if (e.type === 'session_init') {
      if (!firstTask && typeof e.task === 'string') firstTask = e.task;
      if (Array.isArray(e.tools)) toolsAtInit = e.tools;
    } else if (e.type === 'model_change' && typeof e.model === 'string') {
      lastModel = e.model;
    } else if (e.type === 'mode_change' && typeof e.mode === 'string') {
      currentMode = e.mode;
    } else if (e.type === 'compaction' && typeof e.summary === 'string') {
      latestCompactionSummary = e.summary;
    } else if (e.type === 'label' && e.label) {
      labelMoments.push({ id: e.id, label: e.label, timestamp: e.timestamp });
    } else if (e.type === 'message') {
      const msg = e.message || {};
      const text = firstTextBlock(msg.content);
      if (msg.role === 'user' && text) {
        if (!firstTask) firstTask = text;
        lastUserMessage = text;
        toolCallsInFlight = 0;
      } else if (msg.role === 'assistant' && text) {
        lastAssistantText = text;
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block) continue;
          if (block.type === 'tool_use' || block.type === 'tool_call') toolCallsInFlight += 1;
          if (block.type === 'tool_result') toolCallsInFlight = Math.max(0, toolCallsInFlight - 1);
        }
      }
    }
  }
  return {
    sessionId: header.id,
    sessionFile,
    title: header.title || '',
    cwd: header.cwd || '',
    startedAt: header.timestamp || '',
    model: lastModel,
    mode: currentMode,
    firstTask,
    summary: latestCompactionSummary || firstParagraph(lastAssistantText),
    lastUserMessage,
    lastAssistantText,
    tools: toolsAtInit,
    pausedMidTool: toolCallsInFlight > 0,
    labels: labelMoments.slice(-10),
  };
}

module.exports = {
  getAgentDir,
  getSessionsRoot,
  encodeSessionDirName,
  listSessionFilesForCwd,
  findLatestSessionFile,
  findSessionFileById,
  readHeader,
  readEntries,
  distillSession,
  distillSessionSync,
  firstParagraph,
};
