# Installing ATEM on another machine

ATEM is a zero-dependency Node CLI, so installing it elsewhere is just
"get the package onto the machine and `npm install -g` it." These steps
work on **macOS, Linux, and Windows**.

## Prerequisites

- **Node.js ≥ 20** (`node -v`). The machine almost certainly already has it
  if it runs Claude Code / Codex / GSD.
- **git** on PATH (used to group worktrees under their repo).
- The AI tools you want wired up already installed (e.g. **Codex**).

## 1. Get the package onto the machine

Pick whichever is easier.

### Option A — portable tarball (no GitHub access needed)

On the source machine, build the bundle:

```sh
cd atem-agentic-os
npm pack          # → atem-agentic-os-0.2.2.tgz
```

Copy that one `.tgz` file to the target machine (USB, Slack, scp, whatever),
then install it globally:

```sh
# macOS / Linux
npm install -g ./atem-agentic-os-0.2.2.tgz
# Windows (PowerShell or cmd)
npm install -g .\atem-agentic-os-0.2.2.tgz
```

### Option B — straight from GitHub (needs repo access)

```sh
npm install -g github:Atemndobs/atem-agentic-os
# or a pinned release:
npm install -g github:Atemndobs/atem-agentic-os#v0.2.2
```

Either way you now have a global `atem` command:

```sh
atem --help
```

## 2. Wire ATEM into your agents (Codex, etc.)

```sh
atem install
```

This registers ATEM as an MCP server in every detected provider. For **Codex**
it adds an `[mcp_servers.atem]` block to `~/.codex/config.toml` that launches
`node <path>/atem.js mcp-server` — portable across OSes. **Restart Codex** (or
your provider apps) afterwards so they pick up the new MCP config.

Now Codex on that machine can call the handoff tools (`atem_handoff`,
`atem_status`, `atem_adopt`, …) and benefit from the shared continuity
contract — the same as on the source machine.

## 3. Read all your plans in the browser

```sh
atem web
```

Opens the planning viewer at `http://127.0.0.1:4400` (auto-opens the default
browser on macOS/Windows/Linux; pass `--no-open` to skip, `--port <n>` to
change the port). It scans this machine's own `~/.claude`, `~/.codex`, and
`~/.atem` — so it shows that machine's projects, worktrees, hand-offs, and
plans.

## Windows notes (v0.2.2+)

- **Hand-off scaffolding** (`~/.atem/handles/`) works without Administrator or
  Developer Mode: where Windows denies symlinks, ATEM falls back to a junction
  (directories) or a hard link (files), both of which stay live. If you *do*
  enable Developer Mode you'll get real symlinks, but it isn't required.
- **Provider detection** (`codex`, `claude`, `cursor`, `opencode`) uses `where`
  on Windows, so installed CLIs are found normally.
- **Live session detection** in `atem status` uses `ps`/`lsof`, which don't
  exist on Windows — that one view is degraded, but it never errors, and the
  MCP handoff tools and `atem web` don't depend on it.

## Updating later

Re-run the install with a newer tarball / ref:

```sh
npm install -g ./atem-agentic-os-<new>.tgz   # or github:…#<ref>
```
