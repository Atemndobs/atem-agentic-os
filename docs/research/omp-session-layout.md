# omp Session Layout — Research Findings (T1.1)

> Task: T1.1 of `docs/sub-plan-omp-and-url-scheme.md`
> Source: `can1357/oh-my-pi` @ default branch, shallow-cloned 2026-06-01
> Status: complete — no code written, layout documented

This document captures everything ATEM's omp adapter needs to know about how
omp stores its on-disk state. It is the spec the Phase 1 tasks (T1.2 – T1.8)
implement against.

---

## TL;DR

- omp binary name: `omp`
- Config root: `~/.omp/`
- Agent dir: `~/.omp/agent/`
- Sessions root: `~/.omp/agent/sessions/`
- Per-project sessions: `~/.omp/agent/sessions/<encoded-cwd>/`
- Session file: `<session-id>.jsonl` (append-only JSONL)
- First line: `SessionHeader` (`type: "session"`, cwd, id, title, timestamp)
- Subsequent lines: typed entries (`message`, `model_change`, `mode_change`,
  `compaction`, `session_init`, etc.)
- Rule files omp obeys: `AGENTS.md`, `CLAUDE.md`, `.omp/`, `.cursorrules`,
  `.clinerules`, MDC, and others (omp inherits existing formats — see §6)
- Project-local config dir: `.omp/` at the repo root
- Process cwd → repo: omp records cwd in the session header; matches process
  cwd of the running `omp` process.

---

## 1. Filesystem layout

### 1.1 Root directories (from `packages/utils/src/dirs.ts`)

| Helper                  | Path                                | Notes                            |
| ----------------------- | ----------------------------------- | -------------------------------- |
| `getConfigRootDir()`    | `~/.omp`                            | top-level config                 |
| `getAgentDir()`         | `~/.omp/agent`                      | runtime config                   |
| `getSessionsDir()`      | `~/.omp/agent/sessions`             | all per-project session dirs     |
| `getBlobsDir()`         | `~/.omp/agent/blobs`                | content-addressed blob store     |
| `getReportsDir()`       | `~/.omp/reports`                    | reports                          |
| `getLogsDir()`          | `~/.omp/logs`                       | dated logs                       |
| `getPluginsDir()`       | `~/.omp/plugins`                    | installed plugins                |
| `getProjectAgentDir()`  | `<cwd>/.omp`                        | project-scoped config            |

Overridable via `setAgentDir()` / env `PI_CODING_AGENT_DIR`. XDG-aware on
non-mac platforms (some helpers fall back to `XDG_*` dirs). ATEM should
honor `PI_CODING_AGENT_DIR` if set, otherwise default to `~/.omp/agent`.

### 1.2 Per-project session dir encoding

omp encodes the cwd into a single directory name:

- If cwd is **under `$HOME`**: `-<rel-to-home-with-slashes-replaced-by-dashes>`
  - Example: `/Users/atem/sites/atem-agentic-os` →
    `-sites-atem-agentic-os`
- If cwd is **under `os.tmpdir()`**: `-tmp-<rel-to-tmp>` (same encoding)
- Otherwise (legacy absolute): `--<abs-path-stripped-leading-slash-dashed>--`
  - Example: `/opt/repos/foo` → `--opt-repos-foo--`

Source: `packages/coding-agent/src/session/session-manager.ts`
functions `getDefaultSessionDirName`, `encodeLegacyAbsoluteSessionDirName`,
`encodeRelativeSessionDirName`. omp also has a one-time migration that
renames old `--<home-encoded>-*--` dirs into the new `-*` form
(`migrateHomeSessionDirs`). ATEM's adapter must accept both forms.

**ATEM implementation note:** because the encoding is lossy (every `/`, `\`,
`:` becomes `-`), don't try to reverse it. Always source the canonical cwd
from the session header's `cwd` field (§2.1), not from the directory name.
Use the encoded name only as a key.

### 1.3 Session file

Per-cwd dir contains one or more `.jsonl` files. Each is a complete session.
Filename = session id (UUID). Append-only, line-delimited JSON.

Example tree:

```
~/.omp/agent/sessions/
  -sites-atem-agentic-os/
    01HGY4Z2-...-abc.jsonl       <- one session
    01HGY5K7-...-def.jsonl       <- another session
  -tmp-omp-research/
    01HGY8M1-...-xyz.jsonl
```

---

## 2. Session JSONL format

### 2.1 First line — header

```ts
interface SessionHeader {
  type: "session";
  version?: number;       // v1 sessions omit this
  id: string;             // UUID — also the filename
  title?: string;         // auto-generated from first user message
  titleSource?: "auto" | "user";
  timestamp: string;      // ISO-8601, session creation
  cwd: string;            // absolute cwd at session start
  parentSession?: string; // forked sessions
}
```

`cwd` is the authoritative repo identifier. **ATEM joins on `cwd`** to
attribute a session to a known repo.

### 2.2 Subsequent lines — typed entries

All entries share:

```ts
interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;  // tree structure (forks/branches)
  timestamp: string;
}
```

Entry types relevant to ATEM (full list in `session-manager.ts` ~lines 60-230):

| `type`                  | What ATEM extracts                                |
| ----------------------- | ------------------------------------------------- |
| `message`               | role + content (`AgentMessage`) → conversation    |
| `session_init`          | `systemPrompt`, `task`, `tools[]` → first intent  |
| `model_change`          | `model` (`provider/modelId`), `role`              |
| `mode_change`           | `mode` (e.g. `"plan"`), `data` (plan file path)   |
| `compaction`            | `summary` → distilled state if model compacted    |
| `branch_summary`        | `summary` of an abandoned branch                  |
| `ttsr_injection`        | which time-traveling stream rules fired           |
| `label`                 | user bookmarks on entries                         |

Entries form a tree via `parentId` (forks / re-rolls). The *active* path is
the latest leaf reachable from the head — but for distillation ATEM does
**not** need to reconstruct the tree. It can scan linearly and use the most
recent entry of each kind (last `message`, last `model_change`,
last `mode_change`, last `compaction`).

### 2.3 Plan distillation algorithm

For ATEM's "what is omp doing right now" extraction:

1. Read header → cwd, title, started-at.
2. Linear scan, track:
   - `lastUserMessage`     (last `message` with `role: "user"`)
   - `lastAssistantText`   (last `message` with `role: "assistant"` and a text block)
   - `lastModel`           (last `model_change.model`)
   - `currentMode`         (last `mode_change.mode`; default `"none"`)
   - `latestCompaction`    (last `compaction.summary` — the model's own digest)
   - `firstTask`           (any `session_init.task`, else first user message)
   - `tools`               (`session_init.tools[]` if present)
3. Emit:
   - `state.summary`  ← `latestCompaction ?? lastAssistantText.firstParagraph`
   - `state.provider` ← `omp`
   - `state.repo`     ← header.cwd
   - `next.md`        ← derived from `currentMode`+`lastAssistantText` tail
   - `brief.goal`     ← `firstTask`
   - `decisions.md`   ← entries with `type: "label"` (user-marked moments)

`session_init` and `compaction` summaries are the highest-signal sources;
prefer them when present.

---

## 3. Process detection

- Binary name: `omp` (npm: `@oh-my-pi/pi-coding-agent`).
- Detect via `pgrep -fl '^omp( |$)'` or scan `/proc` / `ps aux`.
- Get cwd of each pid (`lsof -p $PID -d cwd -Fn` on macOS/Linux,
  `readlink /proc/$PID/cwd` on Linux).
- Match cwd against the encoded session dir; pick the most-recently-modified
  `.jsonl` for that dir → the live session.

ATEM already has provider detection infrastructure in `src/cli.js`
(`commandStatus`, `isPidAlive`); the omp probe slots in alongside the
existing claude-code/codex probes.

---

## 4. Rule file discovery (handoff TO omp)

omp natively reads (from `packages/coding-agent/src/discovery/`):

- `<cwd>/.omp/` — project-local omp config
- `<cwd>/AGENTS.md` — Codex-compatible
- `<cwd>/CLAUDE.md` — Claude-compatible
- `<cwd>/.cursorrules`, `.cursor/rules/*.mdc`
- `<cwd>/.clinerules`
- GitHub Copilot `applyTo` formats
- `~/.omp/agent/` — user-level config

**For T1.5 (handoff TO omp):** write `AGENTS.md` at the target repo root.
omp picks it up on its next launch with no further wiring. The same file is
read by Codex, so if a Codex handoff already populated `AGENTS.md`, omp
inherits it for free — and vice versa.

ATEM should not write into `~/.omp/agent/` (that's user-global).

---

## 5. Handoff FROM omp — read paths

For T1.6, ATEM's omp adapter reads:

1. `~/.omp/agent/sessions/<encoded-cwd>/<session-id>.jsonl`
2. Apply the distillation algorithm in §2.3.
3. Write the result into ATEM's session files (`state.md`, `next.md`,
   `brief.md`, `decisions.md`) under the existing session schema —
   never touching omp's jsonl.

This is strictly read-only on omp's side. omp's next release can change
internal types freely; only changes to `SessionHeader` and the
`message`/`compaction`/`mode_change`/`session_init` shapes affect us.
Those are stable public-ish surfaces.

---

## 6. omp's existing rule-format readers (for reference)

omp inherits eight rule formats in their native shape (`README.md` §13 and
`packages/coding-agent/src/discovery/`):

- Cursor MDC (`.cursor/rules/*.mdc`)
- Cline `.clinerules`
- Codex `AGENTS.md`
- Copilot `applyTo`
- Claude `CLAUDE.md`
- omp `.omp/`
- Pi `.pi/`
- generic project AGENTS

This is reference only — ATEM does not need to import these readers. The
takeaway is: any rule file ATEM writes in one of these formats is picked up
by omp without further configuration.

---

## 7. Stable contract surface for ATEM

The minimum subset of omp internals ATEM's adapter depends on:

| Field / path                                 | Stability   | If it changes                          |
| -------------------------------------------- | ----------- | -------------------------------------- |
| `~/.omp/agent/sessions/`                     | high        | unlikely; long-standing convention     |
| Encoded cwd dir naming                       | medium      | omp has migration code; we accept both |
| `SessionHeader.{type,id,cwd,timestamp,title}`| high        | core schema, persisted forever         |
| `message` entries with `role` + content      | high        | core schema                            |
| `compaction.summary`                         | high        | core schema                            |
| `mode_change.mode`                           | medium      | mode names may grow                    |
| `session_init.{task,systemPrompt,tools}`     | medium      | subagent-specific, present when relevant |
| Process name `omp`                           | high        | the binary name                        |

Everything else (TTSR, MCP selection, labels, custom entries) is
opportunistic — read if present, ignore otherwise.

---

## 8. Open questions deferred to implementation

These do not block T1.2 onward; they get resolved during build:

- **Concurrent sessions in the same cwd.** Multiple `omp` instances in the
  same repo each write their own jsonl. The adapter picks the
  newest-mtime file, but the "right" choice may need to match by pid →
  session id; defer to T1.2 once we see real behavior.
- **Sessions that never produced a `session_init` entry.** Top-level
  interactive sessions may skip it. Distillation falls back to the first
  user `message`.
- **Sessions where the assistant is mid-tool-call.** The last entry may be
  a tool call without a response. State summary should note this so the
  next provider knows omp is paused mid-tool.

---

## 9. Reference paths in the omp repo

For future spelunking:

- Session storage: `packages/coding-agent/src/session/session-manager.ts`
- Dirs/paths:      `packages/utils/src/dirs.ts`
- Rule discovery:  `packages/coding-agent/src/discovery/`
- Plugins:         `packages/coding-agent/src/extensibility/plugins/`
- Auth/secrets:    `packages/coding-agent/src/session/auth-broker-config.ts`,
                   `packages/coding-agent/src/secrets/`

---

## 10. Conclusion for the sub-plan

T1.1 is complete. T1.2 (provider detection) can proceed against a
well-known process name and session-dir convention. T1.3 (session reader)
has a concrete JSONL schema and a documented distillation algorithm.
T1.5 (handoff TO omp) has a concrete artifact to emit: `AGENTS.md` at the
target repo root. T1.6 (handoff FROM omp) reads jsonl, writes ATEM session
files — no two-way coupling.

The integration boundary is exactly what the sub-plan promised: ATEM reads
omp's stable file layout, never imports omp code, and every omp release is
automatically inherited by ATEM users who run omp.
