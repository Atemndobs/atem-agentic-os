// Show/hide configuration for the planning viewer. Stored durably at
// ~/.atem/web-config.json and mirrored into the browser for instant
// toggling. The server only persists it; the client applies the filters.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = {
  showTasks: true,
  showWorktrees: true,
  showClaudeMemory: true,
  showExecuted: true,       // orange/done plans
  showUncategorized: true,  // docs with no plan status
  hideFolders: [],          // substring match against any folder segment
  hideFiles: [],            // substring match against the filename
  hideProjects: [],         // substring match against a repo/worktree label
};

const BOOL_KEYS = ['showTasks', 'showWorktrees', 'showClaudeMemory', 'showExecuted', 'showUncategorized'];
const LIST_KEYS = ['hideFolders', 'hideFiles', 'hideProjects'];

function asList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

// Produce a clean config: known keys only, correct types, merged over defaults.
function sanitize(incoming = {}) {
  const c = { ...DEFAULTS };
  for (const k of BOOL_KEYS) {
    if (k in incoming && typeof incoming[k] === 'boolean') c[k] = incoming[k];
  }
  for (const k of LIST_KEYS) {
    if (k in incoming) c[k] = asList(incoming[k]);
  }
  return c;
}

function configPath(opts = {}) {
  return opts.configPath
    || process.env.ATEM_WEB_CONFIG
    || path.join(os.homedir(), '.atem', 'web-config.json');
}

function loadConfig(opts = {}) {
  try {
    return sanitize(JSON.parse(fs.readFileSync(configPath(opts), 'utf8')));
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(opts = {}, incoming = {}) {
  const clean = sanitize(incoming);
  const p = configPath(opts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(clean, null, 2));
  return clean;
}

module.exports = { DEFAULTS, sanitize, configPath, loadConfig, saveConfig };
