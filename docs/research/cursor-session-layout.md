# Cursor Session Layout — Research Findings (G.1.1)

> Sub-plan: continuation of W3 (Provider Adapter Layer).
> Status: storage format probed completely; URL scheme + CLI surface
> still pending because Cursor.app was not installed on the probe
> machine (only `~/Library/Application Support/Cursor/` remained).
> Mirrors the shape of: `omp-session-layout.md`,
> `claude-code-session-layout.md`, `codex-bridge.md`.

---

## TL;DR

- Cursor is a VS Code fork; reuses VS Code's `state.vscdb` SQLite KV pattern.
- Chat data is split across **per-workspace** index + **global** content:
  - **Per-workspace** `~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/state.vscdb`
    holds a JSON list of composer IDs visible in that workspace.
  - **Global** `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
    holds the actual messages (bubbles), composer metadata, code-block
    diffs, and checkpoints.
- Each workspace dir has `workspace.json` with `{"folder": "file:///..."}`
  — that's how we map cwd → composers.
- Composer = conversation session. Bubble = single message turn.
- **Read-only adapter is straightforward.** Distillation produces the
  same shape as omp/claude-code distillers.
- **Launcher viability**: SQLite-write to insert a new composer + bubble
  works the same way Codex's `state_5.sqlite` write does (D.7 pattern).
  Whether Cursor refreshes its in-process state without restart is
  unknown — needs live probe.

---

## 1. Filesystem layout

```
~/Library/Application Support/Cursor/
├── User/
│   ├── globalStorage/
│   │   ├── state.vscdb              ← messages + composer metadata
│   │   ├── state.vscdb.backup
│   │   └── <extension-id>/          ← per-extension global state
│   └── workspaceStorage/
│       └── <md5-hash>/
│           ├── state.vscdb          ← per-workspace KV (composer index)
│           ├── state.vscdb.backup
│           └── workspace.json       ← { "folder": "file:///path/to/repo" }
├── Backups/, Cache/, …              ← Chromium/Electron internals
└── …
```

`~/.cursor/extensions/` mirrors `~/.vscode/extensions/` — extension
installs, not chat data.

## 2. Per-workspace state.vscdb (the index)

Schema:

```sql
CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
```

The relevant key:

```
composer.composerData → JSON
  {
    "allComposers": [
      {
        "type": "head",
        "composerId": "<uuid>",
        "createdAt": <ms-epoch>,
        "unifiedMode": "agent" | "edit" | "ask" | …,
        "forceMode": "edit" | …,
        "hasUnreadMessages": false,
        "totalLinesAdded": 0,
        "totalLinesRemoved": 0,
        "filesChangedCount": 0,
        "isArchived": false,
        "isDraft": false,
        "isWorktree": false,
        "branches": []
      },
      …
    ],
    "selectedComposerIds": ["..."],
    "lastFocusedComposerIds": ["..."],
    "hasMigratedComposerData": true,
    "hasMigratedMultipleComposers": true
  }
```

So per workspace we get a list of composer IDs — but no message content here.

## 3. Global state.vscdb (the content)

Two tables:

```sql
CREATE TABLE ItemTable      (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
CREATE TABLE cursorDiskKV   (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
```

`cursorDiskKV` is Cursor's purpose-built KV store. Key prefixes:

| Prefix                            | Meaning                                              |
| --------------------------------- | ---------------------------------------------------- |
| `composerData:<composerId>`       | Full composer state + ordered list of bubble headers |
| `bubbleId:<composerId>:<bubbleId>` | One message turn (full text + attachments)          |
| `checkpointId:<composerId>:<id>`  | Conversation checkpoint                              |
| `codeBlockDiff:<composerId>:<id>` | Stored edit diff                                     |
| `codeBlockPartialInlineDiffFate:…` | Inline diff acceptance state                        |
| `composer.autoAccept.lastSeenHe…` | Settings cache                                       |

### 3.1 `composerData:<id>` shape

```jsonc
{
  "_v": 9,
  "composerId": "e840673b-a470-4037-b2a7-b16615ccf146",
  "richText": "{\"root\":{ ... lexical editor state ... }}",
  "hasLoaded": true,
  "text": "",                                  // composer-level draft text
  "fullConversationHeadersOnly": [
    { "bubbleId": "<id>", "type": 1 },         // type 1 = user message
    { "bubbleId": "<id>", "type": 2 },         // type 2 = assistant message
    {
      "bubbleId": "<id>",
      "type": 2,
      "serverBubbleId": "<cursor-cloud-id>"    // synced bubbles
    },
    …
  ]
  // + many more state fields (~200KB total for a long conversation)
}
```

**`fullConversationHeadersOnly` is the ordered turn list** — index for
walking the conversation in order. `type` encodes role.

### 3.2 `bubbleId:<composerId>:<bubbleId>` shape

```jsonc
{
  "_v": 3,
  "type": 1 | 2,                               // 1=user, 2=assistant
  "bubbleId": "<id>",
  "text": "<plain text message content>",
  "richText": "{lexical editor state}",
  "approximateLintErrors": [],
  "lints": [],
  "codebaseContextChunks": [],
  "commits": [],
  "pullRequests": [],
  "attachedCodeChunks": [],
  "assistantSuggestedDiffs": [],
  "gitDiffs": [],
  "interpreterResults": [],
  "images": [],
  "attachedFolders": [],
  "attachedFoldersNew": [],
  "userResponsesToSuggestedCodeBlocks": [],
  "suggestedCodeBlocks": [],
  "toolResults": [],
  "notepads": [],
  "capabilities": [],
  …                                            // ~50 more state fields
}
```

For distillation we care about: `text` (plain), `type` (role),
`toolResults` (if mid-tool), `suggestedCodeBlocks` (assistant edits).

## 4. Mapping cwd → composers

```
1. Walk workspaceStorage/* entries.
2. For each, read workspace.json — compare its `folder` URI to the
   target cwd (file:///<absolute-path>).
3. On match, open that workspaceStorage/<hash>/state.vscdb.
4. Read composer.composerData → allComposers[].composerId.
5. For each composerId, the global state.vscdb has composerData:<id>
   and bubbleId:<id>:* for the actual content.
```

Multiple workspaces may match a single cwd if the repo was opened
multiple times. Newest wins (compare `createdAt` on the composers).

## 5. Distillation contract (mirror of omp/claude-code)

`distillSessionSync(file: globalDbPath, composerId)` → standard shape:

```ts
{
  sessionId: composerId,
  sessionFile: globalDbPath,
  title: <truncated first user bubble text>,
  cwd: <resolved from workspaceStorage>,
  startedAt: <createdAt ISO>,
  model: <unknown — Cursor doesn't expose this per-turn in the bubble>,
  mode: <composer.unifiedMode>,              // "agent" | "edit" | "ask"
  firstTask: <first user bubble text>,
  summary: <first paragraph of last assistant bubble>,
  lastUserMessage: <last user bubble text>,
  lastAssistantText: <last assistant bubble text>,
  tools: [],                                  // Cursor doesn't expose tool list
  pausedMidTool: <last bubble has unmatched tool_use>,
  labels: []
}
```

Cursor doesn't expose model/effort on bubbles, so we leave those empty.

## 6. Detection in `atem status`

For each running Cursor process (`pgrep -fl 'Cursor.app'`), use the
existing process scan (already in `getCursorProcesses`). Per workspace:

- Composer with `hasUnreadMessages: true` or most-recent `createdAt` →
  "live" session for that cwd.

For idle sessions in the recent window:

- For each workspaceStorage entry whose `state.vscdb` was modified in
  the last 48h, grab the newest composer for that workspace.

## 7. Launcher viability (G.1.3 design)

Two viable paths:

### Path A — SQLite write (analog of Codex D.7)

1. Generate a new UUID `<new-id>`.
2. Insert into global `state.vscdb.cursorDiskKV`:
   - `composerData:<new-id>` → seeded JSON with `fullConversationHeadersOnly`
     listing one user bubble.
   - `bubbleId:<new-id>:<bubble-id>` → seeded user message with the
     handoff prompt as `text`.
3. Update workspace `state.vscdb.ItemTable.composer.composerData` to
   append the new composer to `allComposers[]`.
4. (Optional) Fire Cursor's URL scheme to focus it.

Pros: zero external dependency, works regardless of Cursor's CLI shape.
Cons: schema versioning (`_v: 3`, `_v: 9`) means we have to track Cursor
upgrades. Same risk as the Codex SQLite write.

### Path B — `.cursorrules` + open repo

1. Write `.cursorrules` at the repo root with the handoff contract
   (same as `AGENTS.md` we already produce for codex / omp).
2. Run `cursor <repo>` or fire `cursor://file/<repo>` to open Cursor at
   the right workspace.
3. User clicks "New chat" — Cursor reads `.cursorrules` and the model
   begins primed.

Pros: zero database surgery, robust across Cursor upgrades.
Cons: extra click required (no pre-created thread in sidebar).

**Recommendation: ship Path B first** (simple, robust). Add Path A as
`atem handoff --to cursor --pre-create-thread` later if the extra click
is meaningfully annoying.

## 8. Open questions for live-probe phase

These can only be answered with Cursor actually installed:

1. **URL scheme.** Almost certainly `cursor://`. Need to confirm the
   exact deep-link grammar — `cursor://file/...?ref=...`? `cursor://open?path=...`?
   Probe via `defaults read .../Info.plist CFBundleURLTypes`.
2. **CLI surface.** Cursor's symlinked binary is `Cursor.app/.../bin/code`
   (VS Code's `code` wrapper). Almost certainly accepts:
   - `cursor <path>` — open path
   - `cursor --new-window <path>` — new window at path
   - `cursor --add <path>` — add to current window
   Need to confirm whether it has any chat-specific flag.
3. **Live-refresh behavior.** If Path A is used: does Cursor's in-process
   state pick up DB changes without restart? If not, the launcher needs
   to either restart Cursor (heavy-handed) or rely on Path B.
4. **`.cursorrules` precedence.** Does `.cursorrules` still work in
   current Cursor, or has it been replaced by `.cursor/rules/*.mdc`?

## 9. Reference paths for re-probing

When Cursor is reinstalled:

```sh
# Storage roots
~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
~/Library/Application Support/Cursor/User/workspaceStorage/<md5>/state.vscdb

# Quick inspections
sqlite3 ~/Library/Application\ Support/Cursor/User/globalStorage/state.vscdb \
  "SELECT key FROM cursorDiskKV WHERE key LIKE 'composerData:%' LIMIT 5"

sqlite3 ~/Library/Application\ Support/Cursor/User/globalStorage/state.vscdb \
  "SELECT substr(value, 1, 300) FROM cursorDiskKV
   WHERE key='bubbleId:<composer-id>:<bubble-id>'"

# URL scheme
defaults read /Applications/Cursor.app/Contents/Info.plist CFBundleURLTypes

# CLI
cursor --help
```

## 10. Conclusion

G.1.1 is complete. We have:

- ✅ Full storage layout documented (workspace index + global content)
- ✅ Bubble + composer schemas mapped to ATEM's distilled shape
- ✅ cwd → composers resolution path identified
- ✅ Two launcher paths designed and compared
- ⏳ URL scheme + CLI flags pending live machine

G.1.2 (Cursor distiller) can proceed against this contract. The
distiller reads workspaceStorage/<hash>/workspace.json to find the
right workspace, then reads the relevant composerId from the global
state.vscdb. Same shape as `omp.js` / `claude-code.js`.

G.1.3 (launcher) ships Path B first — `.cursorrules` writer + spawn
`cursor <path>`. Path A (SQLite pre-create) is an opt-in upgrade once
the URL/CLI probe is done.
