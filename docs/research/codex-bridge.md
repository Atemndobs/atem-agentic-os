# Codex Bridge — Research Findings (E.1)

> Sub-plan: `docs/sub-plan-seamless-handoff.md` (to be drafted).
> Status: probe complete — **Path A is real**, no browser automation needed.
> Probed against `codex` v `/Applications/Codex.app/Contents/Resources/codex`
> on 2026-06-01.

## TL;DR

Codex ships a fully-documented JSON-RPC v2 app-server protocol with explicit
primitives for everything we need:

- **`ThreadStart`** — create a new conversation, scoped to a cwd
- **`ThreadSetName`** — give it a sidebar label
- **`TurnStart`** — push the first user turn into the thread
- **`ThreadResume`** — reattach to an existing thread

The protocol travels over a Unix domain socket. `codex app-server proxy
--sock <path>` exposes it on stdio so any CLI can pipe in/out without
socket plumbing. Schemas live at
`codex app-server generate-json-schema --out <dir>` (v1 + v2 directories).

**Result:** `atem hop --to codex` ships as a thin shim — start the daemon
if needed, proxy stdio, send 3 JSON-RPC calls, done. The session appears
in Codex's sidebar pre-named and pre-primed with the handoff prompt.

## Architecture discovered

```
                                           ┌────────────────────┐
                                           │  Codex Desktop     │
                                           │  (Electron UI)     │
                                           └────────┬───────────┘
                                                    │ (in-process)
                                                    ▼
                                           ┌────────────────────┐
   atem hop --to codex                     │  codex app-server  │
   ┌─────────────────┐                     │  (the daemon)      │
   │  ATEM CLI       │  JSON-RPC v2        │                    │
   │                 │ ◀──────────────────▶│  ThreadStart       │
   │  (this repo)    │  over stdio via     │  TurnStart         │
   │                 │  `codex app-server  │  ThreadSetName     │
   └─────────────────┘  proxy --sock`      │  …+50 others       │
                                           └────────────────────┘
                                                    ▲
                                                    │ Unix socket
                                                    │
                                ~/.codex/app-server-control/<socket>
```

## Key surfaces

### 1. Daemon lifecycle

```sh
codex remote-control start          # boot daemon with remote control on
codex remote-control stop           # stop it
codex app-server daemon version     # JSON: { cli, app_server } versions
codex app-server daemon start       # plain start, no remote-control
codex app-server daemon enable-remote-control
```

Control directory: **`~/.codex/app-server-control/`** (observed). Contains
`app-server-startup.lock` and, when running, the Unix socket file.

### 2. Connecting from a CLI

```sh
codex app-server proxy --sock <path>
```

This is the **bridge entry point**. It pipes stdin → socket and socket →
stdout, so we can spawn it from Node, write JSON-RPC framed messages to
stdin, and parse responses off stdout.

ATEM's adapter uses it like:

```js
const proxy = spawn('codex', ['app-server', 'proxy', '--sock', socketPath]);
proxy.stdin.write(jsonRpcFraming(threadStartRequest));
// read replies from proxy.stdout
```

### 3. Transport modes (alternatives)

`codex app-server --listen <URL>` supports:

| URL                | Use case                              |
| ------------------ | ------------------------------------- |
| `stdio://` (default) | one-shot spawn-and-pipe              |
| `unix://PATH`      | persistent local daemon              |
| `ws://IP:PORT`     | remote drive (WebSocket)             |
| `off`              | disable                              |

For ATEM we use the proxy (simplest), not direct socket connection.

## RPC methods we use

Generated via `codex app-server generate-json-schema --out /tmp/codex-schema`.

### Thread family (the "session" surface)

| Method               | Purpose                                                  |
| -------------------- | -------------------------------------------------------- |
| `ThreadStart`        | Create a new thread; returns `threadId`                  |
| `ThreadSetName`      | Set the visible sidebar label                            |
| `ThreadResume`       | Reopen an existing thread                                |
| `ThreadFork`         | Branch from a thread (good for "alternative timelines")  |
| `ThreadRead`         | Read thread state                                        |
| `ThreadList`         | List threads                                             |
| `ThreadMetadataUpdate` | Stamp custom metadata (ATEM session id, etc.)          |
| `ThreadArchive`      | Move to archive                                          |
| `ThreadGoalSet`      | Set the thread's stated goal                             |

### Turn family (sending the prompt)

| Method               | Purpose                                                  |
| -------------------- | -------------------------------------------------------- |
| `TurnStart`          | Send a user turn; required `{ threadId, input[] }`       |
| `TurnInterrupt`      | Cancel mid-turn                                          |
| `TurnSteer`          | Steer a running turn                                     |

### `ThreadStart` params we care about

From `v2/ThreadStartParams.json`:

```ts
{
  cwd?: string,                   // worktree path → THE key field
  developerInstructions?: string, // hidden system-side context
  baseInstructions?: string,      // model instructions
  serviceName?: string,           // human-visible identifier
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access',
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never' | { granular: {...} },
  model?: string,
  personality?: 'none' | 'friendly' | 'pragmatic',
  threadSource?: 'user' | 'subagent' | 'memory_consolidation',
  sessionStartSource?: 'startup' | 'clear',
  ephemeral?: boolean,
  // …
}
```

For ATEM handoffs we set:

```ts
{
  cwd: targetRepoOrWorktree,                       // the right place
  serviceName: `atem:${syntheticId}`,               // sidebar identifier
  developerInstructions: atemSessionContractBlock,  // ATEM/handoff brief
  threadSource: 'subagent',                         // we are not the human
  sessionStartSource: 'startup',
  approvalPolicy: 'on-request',                     // safe default
}
```

### `TurnStart` params

From `v2/TurnStartParams.json`:

```ts
{
  threadId: string,                  // required
  input: Array<{ type: 'text', text: string } | { type: 'mention', ... } | … >,
  cwd?: string,
  model?: string,
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
  // …
}
```

The simple form is one `TextUserInput`:

```ts
{
  threadId: 'returned-from-ThreadStart',
  input: [{ type: 'text', text: 'Pick up the ATEM handoff at atem://current/handoff.' }],
}
```

### `UserInput` shapes (relevant subset)

- `{ type: 'text', text }` — most common
- `{ type: 'mention', name, path }` — file mention
- `{ type: 'skill', name, path }` — invoke a Codex skill
- `{ type: 'image', url }` / `{ type: 'localImage', path }` — multi-modal

The `mention` input is interesting — could mention `atem://current/handoff`
directly if the bridge teaches Codex to honor that URL scheme later.

## Process layout observed

```
/Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://
  (the in-process server the Electron app talks to)

/Users/atem/.kiro/extensions/openai.chatgpt-26.519.32039-darwin-arm64/
  bin/macos-aarch64/codex app-server --analytics-default-enabled
  (Kiro/VS Code extension's own server)

/Applications/Codex.app/Contents/MacOS/Codex
  (the desktop app itself)
```

Important: **the Electron app's in-process app-server is on stdio and not
shareable**. ATEM must start its own remote-control daemon to talk to.

## Pieces ATEM needs to write

### 1. `src/adapters/codex-bridge.js`

- `ensureDaemon()` — runs `codex remote-control start` if not running;
  resolves the socket path (default location confirmed at
  `~/.codex/app-server-control/`).
- `connect()` — spawn `codex app-server proxy --sock <path>`; expose
  request/notify methods.
- `threadStart({ cwd, serviceName, developerInstructions, ... })` → threadId
- `threadSetName({ threadId, name })`
- `turnStart({ threadId, text })`

### 2. CLI wiring

`atem hop --to codex` calls into the bridge, builds the params:

```js
const id = await bridge.threadStart({
  cwd: handoffRepoOrWorktree,
  serviceName: `atem:${task.syntheticId}`,
  developerInstructions: handoffContract,
  threadSource: 'subagent',
});
await bridge.threadSetName({ threadId: id, name: `atem: ${task.shortId} ← ${task.fromProvider}` });
await bridge.turnStart({ threadId: id, text: 'Pick up the ATEM handoff. Read atem://current/handoff first.' });
console.log(`Codex thread created: ${id}. Click "atem: ${task.shortId}" in the sidebar.`);
```

### 3. `atem doctor` checks (later)

- Codex installed?
- `~/.codex/app-server-control/` exists and writable?
- Daemon running?

## Open questions to resolve in E.2

1. **JSON-RPC framing**: does the proxy use newline-delimited JSON, or
   LSP-style `Content-Length:` framing? Sample probe by sending an
   `Initialize` request first; the schema for `InitializeParams.json` lives
   in `v1/`.
2. **Auth**: assumed to inherit the running user's Codex auth via
   `~/.codex/auth.json`. Verify on first call.
3. **Socket filename**: only `app-server-startup.lock` present when daemon
   isn't running; need to observe the actual socket name after `codex
   remote-control start`. Likely `app-server.sock` or similar.
4. **Sidebar visibility**: confirm that `serviceName` + `ThreadSetName`
   are what shows in the sidebar (vs. some other field).
5. **`developerInstructions` vs `baseInstructions`**: empirical — which one
   actually persists across turns? Both look right; one might be one-shot.

## What changes if Path A turns out incomplete

- If the proxy stdio framing is undocumented → fall back to direct Unix
  socket connection (we already know the path).
- If `ThreadStart` doesn't produce a sidebar entry → fall back to
  `ThreadSetName` after the fact, or write the same prompt via `codex
  app <PATH>` shell-out (which opens the desktop app pointed at the cwd —
  loses pre-priming but keeps the worktree-targeting win).
- If `developerInstructions` is rejected → put the brief in the first
  `TurnStart` `input` instead.

## Conclusion

E.1 is done. We have:

- ✅ Confirmed JSON-RPC protocol with published schemas
- ✅ Confirmed bridge entry point (`codex app-server proxy --sock`)
- ✅ Confirmed required RPCs (`ThreadStart`, `ThreadSetName`, `TurnStart`)
- ✅ Confirmed thread is cwd-aware (key for worktree handoff)
- ✅ Confirmed daemon lifecycle commands (`codex remote-control start/stop`)

E.2 — implement `src/adapters/codex-bridge.js` + `atem hop --to codex`
— is mostly mechanical: spawn-and-pipe JSON-RPC over a process. We can
test against a real Codex daemon on this machine. ~200–300 lines.

The user's vision — *"pre-created Codex session waiting in the sidebar,
scoped to the right worktree, primed with the handoff"* — is reachable
without any browser automation, any UI scraping, or any new dependencies.

## Known gap: workspace-root registration (worktree handoffs)

Codex Desktop groups threads in the sidebar by git common ancestor.
A thread opened with `cwd=<worktree>` is shown under the parent
repo's project entry, not as its own project, regardless of the
thread's cwd in SQLite. This is *Codex's* design.

`~/.codex/.codex-global-state.json` does have the relevant keys:

- `electron-saved-workspace-roots`: `[string]` — known projects
- `project-order`: `[string]` — sidebar display order
- `thread-workspace-root-hints`: `{ threadId: cwd }` — which project
  a thread belongs to

But the file is **owned by the Electron main process in memory**. Any
external writes to the workspace-root or project-order keys get
clobbered on the next flush. ATEM writes only `thread-workspace-root-
hints` (which Codex doesn't overwrite). The cwd lives durably in
the `threads` SQLite row's `cwd` column.

The bridge does **not** expose a method for adding a workspace root
or pinning a path as its own project. Probed methods (Nov 2026,
codex 0.136.0-alpha.2): `config/value/write` writes the TOML config
only; `externalAgentConfig/import` is for migrating other-AI configs
not workspace registration. Full method list returned by an unknown
method's error message — none match.

### Upstream ask

File an issue / FR with Codex requesting either:

1. A bridge RPC such as `workspace/add` / `workspace/list` /
   `workspace/setOrder` so external orchestrators (ATEM, agents,
   editor integrations) can durably register projects without
   racing the Electron preference store.
2. Per-worktree pinning support — let a worktree path be elevated to
   its own sidebar project entry rather than being collapsed under
   the parent repo by git ancestor.

Either would let ATEM produce a worktree handoff that appears as a
distinct, scannable project in the Codex sidebar. Until then the
title (`atem · <branch> · <short-id> ← <fromProvider>`) is the only
disambiguator when multiple handoffs target different worktrees of
the same repo.

## Reference paths

- Codex binary: `/Applications/Codex.app/Contents/Resources/codex`
- Control dir: `~/.codex/app-server-control/`
- Generated schemas: `/tmp/codex-schema/v2/` (re-generate with `codex
  app-server generate-json-schema --out <DIR>`)
- TS bindings (if we want them): `codex app-server generate-ts --out <DIR>`
