// Turn Claude Code session transcripts into backtest records.
//
// One session file == one ATEM task, because the synthetic ATEM id is
// `claude-code:<sessionId>`. That makes a session the correct unit: it is
// exactly what `atem route` decides about.
//
// The hard rule in here is the split between:
//   digest:  ONLY what exists at routing time (the opening request)
//   outcome: what the session actually cost, known only afterwards
// If anything from `outcome` leaks into `digest`, the backtest is worthless
// because Jev would be judging a task it has already seen the answer to.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { redact, redactionHits } from "./redact.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const DIGEST_CHARS = 1200;

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith(".jsonl")) yield p;
  }
}

/** Flatten a message content field to plain text, dropping tool payloads. */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

// Sessions started by another tool rather than by a person. ATEM would never
// route these, so leaving them in swamps the dataset: on this machine they are
// 89% of all sessions. Measured 2026-09-20, claude-mem's observer accounted for
// 2,245 of 2,512 extracted sessions.
const SYNTHETIC_MARKERS = [
  "<observed_from_primary_session>",
  "You are a Claude-Mem",
  "you are continuing to observe the primary Claude session",
  "<local-command-stdout>",
];

const SYNTHETIC_PROJECTS = new Set(["observer-sessions"]);

export function isSyntheticSession(firstPrompt, project) {
  if (SYNTHETIC_PROJECTS.has(project)) return true;
  return SYNTHETIC_MARKERS.some((m) => firstPrompt.includes(m));
}

/**
 * A real human prompt: typed by the user, not a tool result, not a subagent,
 * not a system-injected reminder.
 */
function isHumanPrompt(rec) {
  if (rec.type !== "user" || rec.isSidechain) return false;
  const c = rec.message?.content;
  if (Array.isArray(c) && c.some((b) => b?.type === "tool_result")) return false;
  const text = contentText(c).trim();
  if (!text) return false;
  if (text.startsWith("<system-reminder>")) return false;
  if (text.startsWith("Caveat:")) return false;
  return true;
}

async function parseSession(file) {
  const out = {
    sessionId: null,
    title: null,
    cwd: null,
    gitBranch: null,
    startedAt: null,
    endedAt: null,
    firstPrompt: null,
    humanPrompts: 0,
    assistantTurns: 0,
    edits: 0,
    bash: 0,
    toolCalls: 0,
    filesTouched: new Set(),
    models: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    maxContextTokens: 0,
    redactions: 0,
    seenMessages: new Set(),
  };

  const rl = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a torn final line on an open session is normal
    }

    if (rec.sessionId && !out.sessionId) out.sessionId = rec.sessionId;
    if (rec.type === "custom-title" && rec.customTitle) out.title = rec.customTitle;
    if (rec.cwd && !out.cwd) out.cwd = rec.cwd;
    if (rec.gitBranch && !out.gitBranch) out.gitBranch = rec.gitBranch;
    if (rec.timestamp) {
      if (!out.startedAt) out.startedAt = rec.timestamp;
      out.endedAt = rec.timestamp;
    }

    if (isHumanPrompt(rec)) {
      out.humanPrompts += 1;
      if (out.firstPrompt === null) {
        out.firstPrompt = contentText(rec.message.content).trim();
      }
      continue;
    }

    if (rec.type !== "assistant" || rec.isSidechain) continue;

    // One API response is written as several records (one per content block),
    // each repeating the same usage. Count usage once per message id or the
    // totals inflate ~2.5x. Measured 2026-09-20: 109,286 records, 42,965 ids.
    const m = rec.message || {};
    const mid = m.id || rec.requestId;
    const firstSight = !mid || !out.seenMessages.has(mid);
    if (mid) out.seenMessages.add(mid);
    if (m.model) out.models.add(m.model);

    const u = m.usage || {};
    if (firstSight) {
    out.assistantTurns += 1;
    const inp = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    out.inputTokens += inp;
    out.outputTokens += u.output_tokens || 0;
    out.cacheReadTokens += u.cache_read_input_tokens || 0;
    out.maxContextTokens = Math.max(
      out.maxContextTokens,
      inp + (u.cache_read_input_tokens || 0),
    );
    }

    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type !== "tool_use") continue;
      out.toolCalls += 1;
      if (EDIT_TOOLS.has(b.name)) {
        out.edits += 1;
        const p = b.input?.file_path || b.input?.notebook_path;
        if (p) out.filesTouched.add(p);
      } else if (b.name === "Bash") {
        out.bash += 1;
      }
    }
  }

  return out;
}

export async function extract({ root, days = 30, minTurns = 2, includeSynthetic = false }) {
  const cutoff = Date.now() - days * 86400_000;
  const records = [];
  const skipped = { stale: 0, empty: 0, tooShort: 0, synthetic: 0 };

  for await (const file of walk(root)) {
    let st;
    try {
      st = await stat(file);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoff) {
      skipped.stale += 1;
      continue;
    }

    const s = await parseSession(file);
    if (!s.firstPrompt || !s.sessionId) {
      skipped.empty += 1;
      continue;
    }
    if (s.assistantTurns < minTurns) {
      skipped.tooShort += 1;
      continue;
    }

    const raw = s.firstPrompt.slice(0, DIGEST_CHARS);
    const project = (s.cwd || "").split("/").filter(Boolean).pop() || "unknown";

    if (!includeSynthetic && isSyntheticSession(s.firstPrompt, project)) {
      skipped.synthetic += 1;
      continue;
    }

    records.push({
      // Identity
      taskId: `claude-code:${s.sessionId}`,
      file,
      title: s.title ? redact(s.title) : null,

      // DIGEST: available at routing time. Nothing below this line may
      // depend on how the session actually went.
      digest: {
        project,
        gitBranch: s.gitBranch || null,
        request: redact(raw),
        truncated: s.firstPrompt.length > DIGEST_CHARS,
      },

      // OUTCOME: observed after the fact. Ground truth lives here.
      outcome: {
        assistantTurns: s.assistantTurns,
        humanPrompts: s.humanPrompts,
        edits: s.edits,
        bash: s.bash,
        toolCalls: s.toolCalls,
        distinctFiles: s.filesTouched.size,
        models: [...s.models],
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheReadTokens: s.cacheReadTokens,
        maxContextTokens: s.maxContextTokens,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
      },

      meta: { redactions: redactionHits(raw) },
    });
  }

  return { records, skipped };
}
