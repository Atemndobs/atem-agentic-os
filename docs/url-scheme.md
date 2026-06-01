# `atem://` URL Scheme

> Status: spec for Phase 2 of `docs/sub-plan-omp-and-url-scheme.md`.
> Implemented in `src/url.js`; surfaced via `atem resolve` and adapter
> `read`/`write`; materialized at `~/.atem/handles/` for providers whose
> tools only read local files.

## Why

ATEM today exposes session state through filesystem paths that change per
session and per harness mode (`global` vs `repo`). Every provider adapter
re-implements the same path-resolution dance, and every CLAUDE.md /
AGENTS.md / `.cursorrules` we generate hardcodes those paths.

`atem://` collapses that into one stable contract. The same string
identifies the same session artifact no matter where on disk it lives or
which provider is reading it. Adding the next provider becomes "tell its
existing `read` tool to follow `atem://current/handoff`," not "write
another path resolver."

## Grammar

```
atem://<target>[/<artifact>][?<query>]

<target>   ::= <task-id> | "current" | "list"
<artifact> ::= "brief" | "state" | "handoff" | "decisions" | "next"
             | "validation" | "log"
             | "snapshots"                          (directory)
             | "snapshots/" <snapshot-id>           (a single snapshot dir)
             | "snapshots/" <snapshot-id> "/" <file>
             | "files/" <session-relative-path>     (any other file in session dir)
<query>    ::= "format=md" | "format=json" | "raw=true"
```

Examples:

| URL                                       | Resolves to                                                |
| ----------------------------------------- | ---------------------------------------------------------- |
| `atem://TASK-001/state`                   | `<harness>/sessions/TASK-001/state.md`                     |
| `atem://TASK-001/handoff`                 | `<harness>/sessions/TASK-001/handoff.md`                   |
| `atem://TASK-001/snapshots`               | `<harness>/sessions/TASK-001/snapshots/`                   |
| `atem://TASK-001/snapshots/2026-06-01-0712` | `<harness>/sessions/TASK-001/snapshots/2026-06-01-0712/`  |
| `atem://current`                          | active task (resolves via cwd → harness `current-session.md`) |
| `atem://current/handoff`                  | active task's `handoff.md`                                 |
| `atem://list`                             | JSON index of all sessions (special, virtual)              |

## Resolution rules

1. **`current`** resolves by reading `<harness>/current-session.md`'s
   `Active Task ID`. If empty, resolution fails with a structured error.
2. **`<task-id>`** must exist as a directory under
   `<harness>/sessions/`. If not, resolution fails.
3. **`<artifact>` aliases** map to the canonical session files. The
   resolver does not auto-create missing files; that remains the job of
   `atem start` and `atem init`.
4. **Snapshots** under `snapshots/<snapshot-id>/` reuse the same
   filesystem path; `snapshots/<id>` returns a directory, `snapshots/<id>/<file>`
   a single file inside it.
5. **`files/<rel>`** is a fallback for anything not yet aliased (e.g.,
   adapter-specific scratch files). Path traversal (`..`) is rejected.
6. **`?format=json`** asks the resolver for a JSON view; resolvers may
   return the canonical local path with `{mimeType: "application/json"}`
   for callers that want to parse the file themselves. Default is markdown.
7. **`?raw=true`** disables the symlink materialization and returns the
   real on-disk path.

## Error model

The resolver returns one of:

```
{ kind: "file", localPath, mimeType, metadata }
{ kind: "directory", localPath, metadata }
{ kind: "virtual", payload, mimeType }       // atem://list returns this
{ kind: "error", code, message }
```

Error codes: `no-active-session`, `unknown-task`, `unknown-artifact`,
`path-traversal`, `missing-file`, `harness-not-initialized`.

## Materialization (symlink farm)

Most providers can only read local files, not custom URL schemes. ATEM
maintains a symlink farm under `~/.atem/handles/`:

```
~/.atem/handles/
  <task-id>/
    brief.md      -> <harness>/sessions/<task-id>/brief.md
    state.md      -> ...
    handoff.md    -> ...
    ...
  current/       -> <task-id>          (symlink updated on route/adopt)
```

A provider with a literal-path `read` tool can hit
`~/.atem/handles/current/handoff.md` and get the live file. The CLI keeps
the farm in sync as a side effect of `route`, `adopt`, `start`, and
`handoff`. `atem doctor` validates the symlinks.

## CLI surface

- `atem resolve <url>` — prints the resolved absolute path, exits non-zero
  if resolution fails.
- `atem url list` (alias `atem resolve atem://list`) — JSON index of
  sessions for tools that want to enumerate.
- `atem url handles` — print the symlink farm root for tooling.

## Generators

`atem instructions` output for each provider includes a "How to find
session files" section referencing `atem://current/*` and falling back
to `$(atem resolve atem://current/handoff)` for shells. Provider rule
files (CLAUDE.md, AGENTS.md, `.cursorrules`) emit the same convention.

## Stability

URL grammar, artifact aliases, and the symlink farm root are stable
contracts. Adding new artifact aliases is additive (non-breaking). The
on-disk *path layout* under `<harness>/` may evolve; the URL scheme
shields callers from those changes.
