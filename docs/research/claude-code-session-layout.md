# Claude Code Session Layout — Research Findings

> Mirror of `docs/research/omp-session-layout.md` for the Claude Code
> provider. Documented before implementing the claude-code distiller so
> the adapter can read a stable contract surface.

## TL;DR

- Process registry: `~/.claude/sessions/<pid>.json` (one JSON per live process)
- Transcript: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` (append-only)
- Encoded cwd: each `/` and `\` replaced with `-`, leading `-` preserved
- Session id: UUID present in both files
- Process registry survives only while the pid is alive; transcripts persist

## 1. Process registry (we already use this)

`~/.claude/sessions/<pid>.json`:

```json
{
  "pid": 26048,
  "sessionId": "e34143cb-1e6c-4ca1-b4a5-ef325c6e857c",
  "cwd": "/Users/atem/sites/atem-agentic-os",
  "startedAt": 1780347267592,
  "procStart": "Mon Jun  1 20:54:27 2026",
  "version": "2.1.156",
  "peerProtocol": 1,
  "kind": "interactive",
  "entrypoint": "claude-desktop"
}
```

Already consumed by `getClaudeSessions()` in `src/cli.js`. We need to
extend it to derive a title from the transcript.

## 2. Transcript location

```
~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
```

Encoding (lossy):

| cwd                                | encoded                              |
| ---------------------------------- | ------------------------------------ |
| `/Users/atem/sites/foo`            | `-Users-atem-sites-foo`              |
| `/Users/atem`                      | `-Users-atem`                        |
| `/tmp/x:colon`                     | `-tmp-x-colon` (`:` also dashed)     |

Same lossy-encoding problem as omp: prefer matching on a parsed cwd from
the transcript header (when present) over reversing the dir name.

## 3. Transcript entry types

Entries seen in real session files:

| `type`              | Purpose                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `queue-operation`   | UI bookkeeping (enqueue/dequeue user input)                             |
| `mode`              | mode transitions (`normal`, etc.)                                       |
| `(no top-level type)` | message records: `{ parentUuid, message: {...}, isSidechain, ... }`   |

Message records use Anthropic-style messages:

```jsonc
{
  "parentUuid": "cad79b86-...",
  "isSidechain": false,
  "message": {
    "model": "claude-opus-4-7",
    "id": "msg_...",
    "type": "message",
    "role": "assistant" | "user",
    "content": <string | array of blocks>,
    ...
  },
  "requestId": "req_...",
  ...
}
```

Content blocks observed:

- `{type: "text", text: "..."}` — plain text
- `{type: "tool_use", id, name, input}` — assistant calls a tool
- `{type: "tool_result", tool_use_id, content}` — user message carrying tool output

User messages frequently carry plain strings; assistant messages carry
arrays.

## 4. What ATEM distills

Mirror the omp distillation contract (see omp-session-layout.md §2.3):

1. Read transcript header (the first message entry with role `user`).
2. Linear scan, tracking:
   - `firstUserMessage` — earliest user text
   - `lastUserMessage` — most recent user text
   - `lastAssistantText` — most recent assistant text block
   - `lastModel` — most recent `message.model`
   - `inflightToolCalls` — count of `tool_use` blocks without a matching
     `tool_result` (paused-mid-tool signal)
   - `currentMode` — most recent `mode` entry's `mode` field
3. Derive a title from `firstUserMessage` (truncate to 60 chars).
4. Emit the same shape the omp adapter does:
   - `sessionId`, `cwd`, `title`, `startedAt`, `model`, `mode`
   - `firstTask` (≈ first user message)
   - `summary` (last assistant text first paragraph)
   - `lastUserMessage`, `lastAssistantText`
   - `pausedMidTool`

`isSidechain: true` entries represent subagent turns; we skip them when
deriving the canonical conversation state.

## 5. Linking process → transcript

For a live session detected via `~/.claude/sessions/<pid>.json`:

1. Read the small registry file → `{sessionId, cwd, startedAt, entrypoint}`.
2. Compute the encoded cwd dir name.
3. Look for `<sessionId>.jsonl` in that dir.
4. If missing, fall back to the newest jsonl in that dir whose first
   message references the same sessionId (defensive — Claude has shipped
   layout migrations before, same risk as omp).

## 6. Stability surface

| Field / path                                | Stability    |
| ------------------------------------------- | ------------ |
| `~/.claude/sessions/<pid>.json`             | high         |
| `~/.claude/projects/<encoded>/<id>.jsonl`   | high         |
| `message.role`, `message.content`           | high (LLM API shape) |
| `message.model`                             | high         |
| `parentUuid` thread structure               | medium       |
| `mode` entries                              | medium       |

## 7. Conclusion

The claude-code adapter follows the same shape as omp:
- `findSessionFileForRegistry({sessionId, cwd})` → jsonl path
- `findSessionFileById(sessionId)` → jsonl path
- `readEntries(file)` → message-only array
- `distillSessionSync(file)` → same shape as omp distill
- `resolveSynthetic(syntheticId, artifact)` → markdown view

No claude-code code is imported. We read its on-disk format and stay
read-only. Same provenance + integrity story as omp.
