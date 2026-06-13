# Planning Web Viewer (`atem web`) — Design

**Date:** 2026-06-13
**Status:** Approved by user (brainstorming session)
**Goal:** Read all agent planning files — ATEM task files and per-repo project planning docs — as well-formatted HTML in a browser, with search and live reload.

## Problem

Planning documents produced by AI coding agents (Claude Code, Codex today; Gemini/Cursor later) are scattered markdown files:

1. **ATEM task files** — `~/.atem/harness/sessions/<task>/` holds seven canonical files per task: `brief.md`, `state.md`, `next.md`, `decisions.md`, `validation.md`, `log.md`, `handoff.md`. (`~/.atem/handles/` contains symlinks into this store.)
2. **Per-repo project planning docs** — GSD-style `.planning/**` trees, `docs/sub-plans/`, `docs/PLAN.md`, `PLAN.md`, `AGENTS.md`.

Reading these means opening raw markdown in an editor, file by file. There is no unified, readable view.

## Decision summary

| Decision | Choice |
| --- | --- |
| Scope | Both sources: ATEM task files AND repo planning docs |
| Project coverage | All projects on this machine, discovered via agent registries (not just ATEM-referenced repos) |
| Delivery | Local server (`atem web`), not static export |
| Client | Interactive SPA (hash routing, collapsible tree, dashboard, in-app links) — not static per-page HTML |
| v1 features | Browsing/reading + full-text search + live reload |
| Approach | Zero-dependency, built into the atem CLI (no npm deps, matching ATEM's existing zero-dep philosophy) |

## Architecture

New CLI command `atem web [--port N] [--no-open]`, implemented as `commandWeb()` in `src/cli.js` following the existing `commandX()` pattern, delegating to a new `src/web/` module:

```
src/web/
  scan.js       # source discovery → document tree
  markdown.js   # markdown → HTML renderer
  server.js     # node:http server, routes, SSE
```

### scan.js — source discovery

Returns a tree of documents from both sources:

- **Tasks group:** every session directory under `~/.atem/harness/sessions/`, using existing `src/handles.js` (`listHandles()`) and `src/adapters/session.js` helpers, **excluding `_archive/`** (same convention as `src/recovery.js`). Each task exposes its seven canonical markdown files. Provider (claude-code, codex, …) is derived from the handle name prefix; ids without a provider prefix (e.g. `TASK-002`) get no provider badge.
- **Projects group:** ALL projects any agent has worked on on this machine, regardless of location (user requirement, 2026-06-13). Project roots are discovered from the agents' own registries — no full-disk scanning:
  - **ATEM:** repos referenced by any task (`session.listRepos(taskId)`).
  - **Claude Code:** `~/.claude/projects/` directory names, which encode absolute paths with dashes. Decoding is ambiguous (literal dashes vs path separators), so the decoder reconstructs paths greedily by checking filesystem existence; undecodable entries are skipped.
  - **Codex:** `cwd` from the `session_meta` first line of each `~/.codex/sessions/YYYY/MM/DD/*.jsonl` file.
  - Plus the current working repo.

  Roots are deduplicated via realpath; non-existent paths and paths under `/tmp`/`/private/tmp` are skipped; projects with no planning docs are omitted from the tree. Each surviving root is scanned for planning docs reusing the path constants already exported by `src/context.js` — listing **all** matching markdown files, without the `MAX_PLANS` cap. Authoritative scan list: `.planning/**/*.md`, `docs/sub-plans/*.md`, the research and decisions dirs from `context.js` constants (`docs/research/`, `docs/decisions/`, `.planning/research/`, `.planning/decisions/` — already covered by `.planning/**`), `docs/PLAN.md`, `docs/action-plan.md`, `PLAN.md`, `AGENTS.md`.

Every document gets an opaque numeric id (its index in the scanned list). Ids are stable within one scan generation; after a rescan (live reload), the client re-resolves its open document via the refetched tree using the server-provided node/filename keys — a rescan must never silently swap the displayed document. Missing directories and unreadable repos are skipped silently.

### markdown.js — renderer

A small in-repo markdown → HTML renderer (no dependency). Supported constructs, chosen to cover what GSD/ATEM actually generate:

- ATX headings (`#`–`######`)
- Fenced code blocks (with language class), inline code
- Tables (GFM pipe syntax)
- Unordered/ordered lists, nested lists, task-list checkboxes
- Blockquotes, horizontal rules
- Links, images, bold, italic, strikethrough
- YAML frontmatter rendered as a metadata card (key/value table) above the document

All input is HTML-escaped before rendering; the renderer is the only component that introduces markup. Unrecognized constructs degrade to escaped plain text — never broken HTML. If rendering quality ever proves insufficient, the renderer is a one-file swap for `marked`.

### server.js — HTTP server

`node:http`, bound to **127.0.0.1 only**. Routes:

| Route | Purpose |
| --- | --- |
| `GET /` | Single embedded HTML page (all CSS/JS inline, no external assets) |
| `GET /api/tree` | JSON sidebar tree (groups → nodes → docs with ids, titles, mtimes) |
| `GET /api/doc?id=N` | Rendered HTML + metadata (title, source path, mtime) + raw markdown |
| `GET /api/search?q=` | Title + full-text matches with line snippets |
| `GET /events` | Server-Sent Events stream for live reload |

Security properties:

- Localhost binding only; no remote exposure.
- Clients reference documents only by opaque id — paths never round-trip through the client, so path traversal is impossible by construction.
- All rendered content passes through the escaping renderer.

Port handling: default port **4400**, auto-increment if in use. `--no-open` skips launching the browser.

## UI — interactive single-page app

The client is a true SPA (vanilla JS, embedded in the single served page — still zero-dep), not static per-request HTML. All navigation happens client-side against the JSON API; the page never reloads.

- **Client-side routing:** hash-based routes (`#/doc/<id>`, `#/`), so every document is deep-linkable and browser back/forward work.
- **Left sidebar:** search box at top, then two groups — *Tasks* (provider badge + task id, seven files beneath each) and *Projects* (repo name, planning doc tree beneath). Groups and nodes are collapsible; state persists in `localStorage`. The active doc is highlighted.
- **Right pane:** rendered document with title, source file path, last-modified time, and a raw-markdown toggle. Documents with 3+ headings get a floating table of contents with scroll-to-section links.
- **Internal links:** relative `.md` links inside a document that resolve to another scanned doc are rewritten to in-app routes (`#/doc/<id>`), so plans that reference each other navigate inside the viewer. External links open normally in a new tab.
- **Home dashboard (`#/`):** shown on launch — recently modified docs across all sources (mtime-sorted), grouped by task/project, so you immediately see what the agents have been writing.
- **Search:** results render as you type (debounced) with snippets; selecting a result navigates in-app. Clearing restores the tree.
- **Live updates:** SSE events update the tree, dashboard, and open document in place — no manual refresh ever needed.
- Readable typography; dark/light theme via `prefers-color-scheme`.

## Live reload

`fs.watch` (recursive — supported on macOS) on the sessions root and each repo's planning dirs. Events debounced ~200 ms, then broadcast over SSE. The client refetches the tree and, if the currently open document changed, re-renders it in place.

## Error handling

- Missing source dirs → skipped, group simply absent.
- Unreadable or deleted file at request time → error card in the content pane, server keeps running.
- Port in use → auto-increment with a console note.
- Unknown route or id → JSON 404.
- The server must never crash on malformed input.

## Testing

Same `node --test` setup as the existing suite (`test/`):

- **Renderer:** unit tests per markdown construct, including escaping of embedded HTML.
- **Scanner:** fixture directories mimicking `~/.atem/harness/sessions` and a repo with `.planning/`; assert tree shape and uncapped listing.
- **Server:** route tests against a real instance on a random port backed by fixtures — tree, doc, search, 404s, and traversal attempts (e.g. `id=../../etc/passwd` must 404).

## Future (explicitly out of scope for v1)

- Static HTML export (`--export`)
- Gemini/Cursor: no work needed — they flow through the same ATEM session store and repo scanning.
- Editing documents from the browser.
