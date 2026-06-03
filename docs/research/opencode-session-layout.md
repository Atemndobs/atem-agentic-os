# OpenCode Session Layout — Research Findings (G.2.1)

> Sub-plan: continuation of W3 (Provider Adapter Layer), G.2 — OpenCode adapter.
> Status: storage format, CLI, and rule-file conventions all fully probed
> against a live install on the test machine. No deferred questions.
> Same shape as `cursor-session-layout.md`.

---

## TL;DR

- OpenCode is a Bun-based TUI agent. Binary: `~/.opencode/bin/opencode`
  (or wherever `which opencode` resolves to).
- Single SQLite DB: **`~/.local/share/opencode/opencode.db`**
  (drizzle-orm migrations; very clean schema).
- Sessions are first-class rows with `directory` (cwd) and `title`
  columns — no opaque JSON blobs to decode for the basics.
- Messages and parts hang off sessions with timestamps; per-message
  metadata in `data` JSON (role/agent/model/cost/tokens).
- **Honors `AGENTS.md` AND `.cursorrules`** — the contract files we
  already write for codex+omp+cursor. Cleanest launcher in the stack.
- CLI ships everything we need:
  - `opencode <project>` — open TUI at path
  - `opencode run "<msg>" --title "<t>"` — non-interactive seed
  - `opencode session list` / `opencode session delete <id>`
  - `opencode export <id>` — JSON dump
  - `opencode db path` / `opencode db [query]` — SQL access
  - `opencode acp` — Agent Client Protocol server (future bridge)
  - `-c/--continue`, `-s/--session <id>`, `--fork`, `--title`, `--agent`

---

## 1. Filesystem layout

```
~/.local/share/opencode/
└── opencode.db                  ← single SQLite database

~/.opencode/
├── bin/opencode                 ← binary
├── mcp.json                     ← MCP config we already write to
└── …                            ← package metadata
```

Per-project config (optional):
```
<repo>/opencode.json[c]          ← per-project settings
<repo>/.opencode/opencode.json[c] ← nested form, also honored
```

## 2. opencode.db schema (relevant tables)

```sql
CREATE TABLE session (
  id                  TEXT PRIMARY KEY,         -- e.g. ses_27...
  project_id          TEXT NOT NULL,
  parent_id           TEXT,                     -- forks
  slug                TEXT NOT NULL,            -- "cosmic-engine"
  directory           TEXT NOT NULL,            -- absolute cwd
  title               TEXT NOT NULL,            -- human-readable
  version             TEXT NOT NULL,
  share_url           TEXT,
  summary_additions   INTEGER,                  -- LOC delta
  summary_deletions   INTEGER,
  summary_files       INTEGER,
  summary_diffs       TEXT,
  revert              TEXT,
  permission          TEXT,
  time_created        INTEGER NOT NULL,
  time_updated        INTEGER NOT NULL,
  time_compacting     INTEGER,
  time_archived       INTEGER,                  -- NULL = active
  workspace_id        TEXT
);

CREATE TABLE project (
  id                  TEXT PRIMARY KEY,
  worktree            TEXT NOT NULL,            -- absolute path
  vcs                 TEXT,
  name                TEXT,
  icon_url, icon_color,
  time_created, time_updated, time_initialized INTEGER,
  sandboxes           TEXT NOT NULL,
  commands            TEXT
);

CREATE TABLE message (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  time_created  INTEGER NOT NULL,
  time_updated  INTEGER NOT NULL,
  data          TEXT NOT NULL                    -- JSON: role/agent/model/...
);

CREATE TABLE part (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL,
  time_created  INTEGER NOT NULL,
  time_updated  INTEGER NOT NULL,
  data          TEXT NOT NULL                    -- JSON: { type: "text" | "tool", ... }
);
```

Related but secondary: `account`, `account_state`, `control_account`,
`event`, `event_sequence`, `session_entry`, `session_share`, `todo`,
`workspace`, `__drizzle_migrations`.

## 3. message.data shape

```jsonc
{
  "parentID": "msg_d93216558001UAL6QdnJAy7QGX",
  "role": "user" | "assistant",
  "agent": "build",                              // agent name
  "model": { "providerID": "opencode", "modelID": "big-pickle" },
  "mode": "build",                               // sometimes present
  "path": { "cwd": "/Users/atem/sites/market", "root": "/" },
  "cost": 0,
  "tokens": {
    "input": 0, "output": 0, "reasoning": 0,
    "cache": { "read": 0, "write": 0 }
  },
  "time": { "created": <ms>, "completed": <ms> },
  "error": { "name": "...", … },                 // optional
  "summary": { "diff": …, … }                    // optional
}
```

For distillation we use: `role`, `model.modelID`, `agent`, `time.created`.

## 4. part.data shape

```jsonc
// Text part
{
  "type": "text",
  "text": "User input text or assistant reply text"
}

// Tool-call part
{
  "type": "tool",
  "tool": "bash" | "edit" | "read" | …,
  "callID": "call_function_…",
  "state": {
    "status": "completed" | "pending" | "running" | "aborted",
    "input": { /* tool-specific */ },
    "output": "…",
    "metadata": { … }
  }
}
```

For distillation:
- For each session message: collect its parts ordered by `time_created`.
- Concatenate text-parts to form the message's full text.
- A part with `type === "tool"` and `state.status !== "completed"` flags
  `pausedMidTool`.

## 5. Mapping cwd → sessions

Direct: `SELECT id FROM session WHERE directory = ? AND time_archived IS NULL ORDER BY time_updated DESC`.

Alternative (when several sessions share a project):
```sql
SELECT s.id
  FROM session s
  JOIN project p ON p.id = s.project_id
 WHERE p.worktree = ?
   AND s.time_archived IS NULL
 ORDER BY s.time_updated DESC;
```

## 6. Distillation contract (mirror of omp/claude-code/cursor)

```ts
distillSessionSync(sessionId) → {
  sessionId,
  sessionFile:      "<path-to-opencode.db>",
  title:            session.title,
  cwd:              session.directory,
  startedAt:        ISO(session.time_created),
  model:            <last-message.modelID>,
  mode:             <last-message.mode || last-message.agent>,
  firstTask:        <first user-role message's joined text>,
  summary:          <first paragraph of last assistant message text>,
  lastUserMessage,
  lastAssistantText,
  tools:            [],
  pausedMidTool:    <any part.state.status !== "completed">,
  labels:           []
}
```

## 7. Rule files honored

Probed by ripping the opencode binary for filename string refs:

```
AGENTS.md           ✓ (primary)
cursorrules         ✓
CLAUDE.md           ✓
opencode.json[c]    ✓ (config, not contract)
```

We already produce `AGENTS.md` in `commandHandoff` for codex+omp. **No
extra launcher work required to write a contract file** — the existing
AGENTS.md writer covers OpenCode for free.

## 8. CLI surface (everything we need)

```
opencode [project]          start TUI at project path
opencode run "<msg>"        non-interactive seed turn
  --title <text>            set session title (sidebar identifier)
  --agent <name>            choose agent
  --model <provider/id>     override model
  -s/--session <id>         continue a specific session id
  -c/--continue             continue the last session
  --fork                    fork instead of resume
  --share                   share session URL
  --format json             stream JSON events instead of text
  --attach <url>            attach to a running server

opencode session list                list sessions
opencode session delete <id>         delete a session
opencode export [id]                 dump session as JSON
opencode db path                     print sqlite path
opencode db [query]                  open sqlite shell or run query
opencode acp                         start Agent Client Protocol server
opencode serve                       headless HTTP server
opencode web                         server + web UI
```

## 9. Launcher design

Pick the simplest viable path. OpenCode honors AGENTS.md natively, so:

1. Ensure `AGENTS.md` exists in the target repo with the ATEM block
   (commandHandoff already does this for codex/omp; extend to opencode).
2. Spawn `opencode <repo>` to open the TUI at the worktree.
3. User starts a chat; opencode auto-reads AGENTS.md on first turn.

Optional pre-seed (Path A equivalent for OpenCode):
- `opencode run "<first-turn>" --title "atem: <syntheticId>" --dir <repo>`
- Creates a real session row in the DB, named, with a seed user message.
- User sees it in `opencode session list` and the TUI sidebar.

This Path A is **less risky than Codex/Cursor's** because:
- OpenCode ships `opencode run` as an official non-interactive CLI.
- No need to SQLite-write directly or rebuild the protocol.
- The session shows up correctly without any restart trick.

Recommended: **ship Path A for opencode** (use `opencode run` to seed).
This is what we wanted to do for Codex too, but had to fake via the
bridge — OpenCode just gives us the CLI affordance directly.

## 10. Conclusion

G.2.1 done. We have full storage + CLI knowledge, no deferred questions.

G.2.2 (distiller) reads `opencode.db` via the `sqlite3 -json` pattern
already used by the Cursor distiller. Cwd lookup is a single SQL query.
Message walk is two joined queries (messages + parts).

G.2.3 (launcher) calls `opencode run "<seed>" --title "atem: <id>"
--dir <repo>` non-interactively; AGENTS.md writer in commandHandoff is
extended to include `opencode` alongside `codex` and `omp`.

Cleanest provider integration in the stack.
