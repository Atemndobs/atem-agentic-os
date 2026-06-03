// W7 — failure recovery: detect issues across ATEM sessions and offer
// (or apply) remediations.
//
// Each issue is { code, severity, taskId, message, remedy } where
// remedy is { kind, describe, apply() }. `apply()` returns a result
// string. Pure module — no console output, no side effects until the
// caller invokes a remedy's apply().

const fs = require('node:fs');
const path = require('node:path');

const cli = require('./cli.js'); // shared helpers

const REQUIRED_SESSION_FILES = [
  'brief.md',
  'state.md',
  'handoff.md',
  'next.md',
  'decisions.md',
  'validation.md',
  'log.md',
];

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---- per-session detectors ----------------------------------------------

function nowMs(now) {
  return typeof now === 'number' ? now : Date.now();
}

function detectMissingFiles(paths, taskId) {
  const issues = [];
  const sessionDir = path.join(paths.harnessDir, 'sessions', taskId);
  for (const file of REQUIRED_SESSION_FILES) {
    const full = path.join(sessionDir, file);
    if (!fs.existsSync(full)) {
      issues.push({
        code: 'missing-file',
        severity: 'error',
        taskId,
        message: `${file} is missing`,
        remedy: {
          kind: 'recreate-file',
          describe: `Recreate ${file} from template.`,
          apply() {
            const tmpl = defaultTemplateFor(taskId, file);
            cli.writeFile(full, tmpl);
            return `recreated ${file}`;
          },
        },
      });
    }
  }
  return issues;
}

function detectCorruptedFrontmatter(paths, taskId) {
  const issues = [];
  const statePath = path.join(paths.harnessDir, 'sessions', taskId, 'state.md');
  if (!fs.existsSync(statePath)) return issues;
  const content = cli.readFile(statePath);
  const { data } = cli.parseFrontmatter(content);
  // Required keys we always want.
  const required = ['task_id', 'task_type', 'provider'];
  const missing = required.filter((k) => !data || !data[k]);
  if (missing.length > 0) {
    issues.push({
      code: 'corrupted-frontmatter',
      severity: 'warning',
      taskId,
      message: `state.md frontmatter missing keys: ${missing.join(', ')}`,
      remedy: {
        kind: 're-sync-frontmatter',
        describe: 'Reconstruct frontmatter from `##` section bodies.',
        apply() {
          // syncStateFrontmatter regenerates frontmatter from headings.
          const next = cli.syncStateFrontmatter(content, taskId);
          cli.writeFile(statePath, next);
          return 'frontmatter re-synced';
        },
      },
    });
  }
  return issues;
}

function detectStaleProgress(paths, taskId, opts = {}) {
  const issues = [];
  const threshold = typeof opts.thresholdMs === 'number' ? opts.thresholdMs : STALE_THRESHOLD_MS;
  const statePath = path.join(paths.harnessDir, 'sessions', taskId, 'state.md');
  if (!fs.existsSync(statePath)) return issues;
  let stat;
  try { stat = fs.statSync(statePath); } catch { return issues; }
  const now = nowMs(opts.now);
  if (now - stat.mtimeMs < threshold) return issues;
  const state = cli.readFile(statePath);
  const status = (cli.getSection(state, 'Status') || '').trim().toLowerCase();
  if (status && status !== 'active' && status !== 'in progress' && status !== 'in-progress') {
    return issues; // already closed/archived
  }
  const ageDays = Math.floor((now - stat.mtimeMs) / (24 * 60 * 60 * 1000));
  issues.push({
    code: 'stale-progress',
    severity: 'warning',
    taskId,
    message: `state.md untouched for ${ageDays}d but status is still "${status || 'unknown'}"`,
    remedy: {
      kind: 'archive',
      describe: `Archive the session (move to sessions/.archived/${taskId}/).`,
      apply() {
        const archivedRoot = path.join(paths.harnessDir, 'sessions', '.archived');
        const sourceDir = path.join(paths.harnessDir, 'sessions', taskId);
        cli.ensureDir(archivedRoot);
        const dest = path.join(archivedRoot, taskId);
        fs.renameSync(sourceDir, dest);
        return `moved to ${path.relative(paths.harnessDir, dest)}`;
      },
    },
  });
  return issues;
}

function detectDuplicateProviderBlocks(paths, taskId) {
  const issues = [];
  const statePath = path.join(paths.harnessDir, 'sessions', taskId, 'state.md');
  if (!fs.existsSync(statePath)) return issues;
  const content = cli.readFile(statePath);
  const count = cli.sectionCount(content, 'Active Providers');
  if (count > 1) {
    issues.push({
      code: 'duplicate-provider-blocks',
      severity: 'warning',
      taskId,
      message: `state.md has ${count} duplicate "Active Providers" blocks`,
      remedy: {
        kind: 'deduplicate-sections',
        describe: 'Collapse duplicate sections into one (keeps the last block).',
        apply() {
          const next = cli.removeDuplicateSectionBlocks(content, 'Active Providers');
          cli.writeFile(statePath, next);
          return 'duplicates collapsed';
        },
      },
    });
  }
  return issues;
}

// ---- alias + materialization integrity ---------------------------------

function detectDanglingAliases(paths) {
  const issues = [];
  let table;
  try { table = require('./aliases.js').readAliases(paths); } catch { return issues; }
  for (const [alias, target] of Object.entries(table || {})) {
    const dir = path.join(paths.harnessDir, 'sessions', target);
    if (fs.existsSync(dir)) continue;
    const synthetic = require('./synthetic.js');
    if (synthetic.isSyntheticId(target)) {
      issues.push({
        code: 'dangling-alias-synthetic',
        severity: 'warning',
        taskId: alias,
        message: `alias "${alias}" → unmaterialized synthetic "${target}"`,
        remedy: {
          kind: 'remove-alias',
          describe: `Remove alias "${alias}" from sessions/.aliases.json.`,
          apply() {
            require('./aliases.js').removeAlias(paths, alias);
            return `alias "${alias}" removed`;
          },
        },
      });
    } else {
      issues.push({
        code: 'dangling-alias-missing-task',
        severity: 'error',
        taskId: alias,
        message: `alias "${alias}" → missing task "${target}"`,
        remedy: {
          kind: 'remove-alias',
          describe: `Remove alias "${alias}".`,
          apply() {
            require('./aliases.js').removeAlias(paths, alias);
            return `alias "${alias}" removed`;
          },
        },
      });
    }
  }
  return issues;
}

// ---- whole-harness scan -------------------------------------------------

function listTaskIds(paths) {
  const root = path.join(paths.harnessDir, 'sessions');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    // Skip dot-dirs (.archived/, .aliases.json) and underscore-prefixed
    // system / legacy dirs (_archive/). Real task ids never start with
    // either character — they're TASK-N, provider:<id>, or human aliases.
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
    .map((e) => e.name);
}

function detectAllIssues(paths, { taskId, now, thresholdMs } = {}) {
  const issues = [];
  const tasks = taskId ? [taskId] : listTaskIds(paths);
  for (const t of tasks) {
    issues.push(...detectMissingFiles(paths, t));
    issues.push(...detectCorruptedFrontmatter(paths, t));
    issues.push(...detectStaleProgress(paths, t, { now, thresholdMs }));
    issues.push(...detectDuplicateProviderBlocks(paths, t));
  }
  if (!taskId) {
    issues.push(...detectDanglingAliases(paths));
  }
  return issues;
}

// ---- template fallback for recreated files ------------------------------

function defaultTemplateFor(taskId, file) {
  const stamp = cli.nowStamp();
  switch (file) {
    case 'brief.md':
      return `# Brief\n\n## Task Type\n(set with \`atem note --task-type <type>\`)\n\n## Title\n${taskId}\n\n## Goal\n(rebuilt by atem recover — set goal here)\n`;
    case 'state.md':
      return `# State\n\n## Status\nactive\n\n## Current Provider\nmanual\n\n## Current Summary\n(rebuilt by atem recover)\n\n## Files Touched\nNone yet.\n\n## Last Updated\n${stamp}\n`;
    case 'handoff.md':
      return `# Handoff\n\n## Current Status\nIn progress.\n\n## What Was Done\n(rebuilt by atem recover)\n\n## Next Recommended Action\n(rebuilt by atem recover)\n`;
    case 'next.md':
      return `# Next\n\n(rebuilt by atem recover)\n`;
    case 'decisions.md':
      return `# Decisions\n\n## Decision Log\n\n(rebuilt by atem recover)\n`;
    case 'validation.md':
      return `# Validation\n\n(rebuilt by atem recover)\n`;
    case 'log.md':
      return `# Session Log\n\n### ${stamp}\nFile recreated by atem recover.\n`;
    default:
      return `# ${file}\n\n(rebuilt by atem recover)\n`;
  }
}

module.exports = {
  REQUIRED_SESSION_FILES,
  STALE_THRESHOLD_MS,
  detectMissingFiles,
  detectCorruptedFrontmatter,
  detectStaleProgress,
  detectDuplicateProviderBlocks,
  detectDanglingAliases,
  detectAllIssues,
  listTaskIds,
  defaultTemplateFor,
};
