// Phase B: materialize a synthetic task into a real ATEM session dir.
//
// Idempotent: if the session dir already exists, no-op (just return its
// path + distilled snapshot). Otherwise, populate brief/state/handoff/
// next/decisions/validation/log from the provider adapter's distilled
// view of the provider-side session.
//
// Used by:
//   - the URL resolver when a synthetic id is written
//   - `atem handoff <synthetic-id>` (commandHandoff)
//   - `atem adopt --auto` and `atem adopt <synthetic-id>`

const fs = require('node:fs');
const path = require('node:path');

const synthetic = require('./synthetic.js');

// Conservative task type defaults given a distilled provider view.
function inferTaskType(provider, distilled) {
  if (!distilled) return 'investigation';
  const mode = (distilled.mode || '').toLowerCase();
  if (mode === 'plan') return 'investigation';
  const text = (distilled.firstTask || distilled.title || '').toLowerCase();
  if (/\b(fix|implement|add|build|refactor|migrate|wire|patch)\b/.test(text)) return 'implementation';
  if (/\b(why|investigate|trace|debug|find|locate|diagnose)\b/.test(text)) return 'investigation';
  if (/\b(test|verify|validate|audit|review|check)\b/.test(text)) return 'validation';
  if (/\b(document|docs?|readme|describe)\b/.test(text)) return 'documentation';
  return 'investigation';
}

function renderArtifact(provider, distilled, syntheticId, artifact, taskType) {
  // Reuse the adapter's synthetic renderer where possible; for files
  // not covered by the synthetic stub (e.g. brief/state), build a
  // materialized-form variant that doesn't carry the read-only banner.
  const meta = [
    `- Provider: ${provider}`,
    `- Synthetic id: ${syntheticId}`,
    distilled && distilled.cwd ? `- cwd: ${distilled.cwd}` : '',
    distilled && distilled.title ? `- Title: ${distilled.title}` : '',
    distilled && distilled.model ? `- Model: ${distilled.model}` : '',
    distilled && distilled.mode && distilled.mode !== 'none' ? `- Mode: ${distilled.mode}` : '',
    `- Task type: ${taskType}`,
  ].filter(Boolean).join('\n');

  switch (artifact) {
    case 'brief':
      return `# Brief\n\n${meta}\n\n## Goal\n\n${distilled && distilled.firstTask ? distilled.firstTask : '(captured from provider; refine as needed)'}\n`;
    case 'state':
      return `# State\n\n${meta}\n\n## Current Provider\n\n${provider}\n\n## Current Summary\n\n${distilled && (distilled.summary || distilled.lastAssistantText) || '(materialized from synthetic provider session)'}\n\n## Files Touched\n\nNone yet.\n\n## Last Updated\n\n${new Date().toISOString()}\n`;
    case 'handoff':
      return `# Handoff\n\n${meta}\n\n## Where the previous provider left off\n\n${distilled && (distilled.summary || distilled.lastAssistantText) || '(no progress captured)'}\n\n## Next Suggested Provider\n\n(set via \`atem route\`)\n\n## What Was Done\n\n(provider-side session distilled into this task)\n\n## Current Status\n\n${distilled && distilled.pausedMidTool ? '⚠ Previous provider paused mid tool-call.' : 'In progress.'}\n`;
    case 'next':
      return `# Next\n\n${meta}\n\n1. Read \`atem://current/brief\` and \`atem://current/state\`.\n2. Continue from "Where the previous provider left off" in the handoff.\n3. Update this file before stopping.\n`;
    case 'decisions':
      if (distilled && distilled.firstTask) {
        return `# Decisions\n\n## Decision Log\n\n### ${new Date().toISOString()}\n- Decision: materialized from ${provider} synthetic session\n- Reason: ${distilled.firstTask}\n- Impact: provider chain begins with ${provider}\n`;
      }
      return `# Decisions\n\n## Decision Log\n\n(none captured yet)\n`;
    case 'validation':
      return `# Validation\n\n(none captured yet)\n`;
    case 'log':
      return `# Session Log\n\n### ${new Date().toISOString()}\nMaterialized synthetic task ${syntheticId} from ${provider}.\n`;
    default:
      throw new Error(`unknown materialization artifact: ${artifact}`);
  }
}

function materializeSyntheticTask(syntheticId, paths, opts = {}) {
  const parsed = synthetic.parseSyntheticId(syntheticId);
  if (!parsed) throw new Error(`not a synthetic id: ${syntheticId}`);

  const sessionDir = path.join(paths.harnessDir, 'sessions', syntheticId);
  if (fs.existsSync(sessionDir)) {
    return { taskId: syntheticId, sessionDir, distilled: null, created: false };
  }

  // Pull the distilled view from the provider adapter. We require the
  // adapter to expose its distill helper; non-omp providers currently
  // get a stub.
  const registry = require('./adapters/index.js');
  const adapter = registry.adapters[parsed.provider];
  if (!adapter) throw new Error(`no adapter for provider: ${parsed.provider}`);

  let distilled = null;
  if (parsed.provider === 'omp') {
    const omp = registry.omp;
    let file = opts.sessionFile || null;
    if (!file) file = omp.findSessionFileById(parsed.providerSessionId);
    if (!file && opts.cwd) file = omp.findLatestSessionFile(opts.cwd);
    if (!file) {
      throw new Error(`omp session not found for ${syntheticId}; pass --omp-file or --omp-cwd`);
    }
    distilled = omp.distillSessionSync(file);
    if (!distilled) throw new Error(`failed to distill ${file}`);
  } else if (parsed.provider === 'claude-code') {
    const cc = registry.claudeCode;
    let file = opts.sessionFile || null;
    if (!file) file = cc.findSessionFileById(parsed.providerSessionId);
    if (!file && opts.cwd) file = cc.findLatestSessionFile(opts.cwd);
    if (!file) {
      throw new Error(`claude-code transcript not found for ${syntheticId}; pass --cc-file or --cc-cwd`);
    }
    distilled = cc.distillSessionSync(file);
    if (!distilled) throw new Error(`failed to distill ${file}`);
  } else if (parsed.provider === 'cursor') {
    const cr = registry.cursor;
    let composerId = parsed.providerSessionId;
    if (!cr.findSessionFileById(composerId) && opts.cwd) {
      const latest = cr.findLatestComposerForCwd(opts.cwd);
      if (latest) composerId = latest.composerId;
    }
    if (!cr.findSessionFileById(composerId)) {
      throw new Error(`cursor composer not found for ${syntheticId}; pass --cursor-cwd`);
    }
    distilled = cr.distillSessionSync(composerId, { cwd: opts.cwd || '' });
    if (!distilled) throw new Error(`failed to distill cursor composer ${composerId}`);
  }

  const taskType = opts.taskType || inferTaskType(parsed.provider, distilled);
  fs.mkdirSync(sessionDir, { recursive: true });

  const artifacts = ['brief', 'state', 'handoff', 'next', 'decisions', 'validation', 'log'];
  for (const artifact of artifacts) {
    const content = renderArtifact(parsed.provider, distilled, syntheticId, artifact, taskType);
    const fname = `${artifact}.md`;
    fs.writeFileSync(path.join(sessionDir, fname), content);
  }
  fs.mkdirSync(path.join(sessionDir, 'snapshots'), { recursive: true });

  return { taskId: syntheticId, sessionDir, distilled, created: true, taskType };
}

module.exports = {
  materializeSyntheticTask,
  inferTaskType,
};
